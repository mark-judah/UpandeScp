"""Spray Plan Creator stock dashboard endpoint.

Two-tier inventory model surfaced to creators:

  * **Chemical Stores** are the durable storage. Low-stock thresholds and
    bullet charts on the frontend apply *only* here — the operator needs
    to know when these are running dry.
  * **CSUs (Chemical Stock Units / mixing rooms)** are working stock.
    Anything here is meant to be consumed within ``CSU_MAX_AGE_DAYS``
    days. Threshold-based low-stock alerts do NOT apply to CSUs; the
    only signal we surface is staleness — stock that's been sitting in
    a CSU for too long.

The endpoint returns the two warehouse buckets in parallel so the UI can
render them with different semantics.
"""
from __future__ import annotations

import re
from collections import defaultdict, deque
from datetime import datetime

import frappe
from frappe.utils import add_to_date, get_datetime, now_datetime

from .bulk import _user_has_role
from .scope import _resolve_user_scope


_CHEMICAL_GROUPS = ("CHEMICALS", "Fertilizer")

_CSU_RE = re.compile(r"\bcsu\b", re.IGNORECASE)
_STORE_RE = re.compile(r"^\s*chemical store\b", re.IGNORECASE)

# Hard ceiling on how long chemicals are allowed to sit unused in a CSU
# before they're flagged as aged. The user-facing label on every aged
# badge says ">= N days" so this number is also part of the contract
# with the React page — keep them in sync. Aligned with the CSU-drain
# runbook's STALE_DAYS (5) so the dashboard's "expired" agrees with what
# the drain scripts (doc references/fixes/spray_plan_issue/new) act on.
CSU_MAX_AGE_DAYS = 5

# How far back to walk SLE history when reconstructing CSU cohorts.
# Anything older than this collapses into a single "pre-horizon" cohort
# tagged with the horizon timestamp — for practical CSU ops, anything 60
# days old is so far past CSU_MAX_AGE_DAYS that the exact age doesn't
# matter.
_CSU_AGE_HORIZON_DAYS = 60

# Numeric tolerance for FIFO consumption — Stock Ledger Entry stores
# 9-place precision and float arithmetic can leave fractional dust that
# breaks the "queue empty?" check.
_QTY_EPS = 1e-9


def _classify(warehouse_name: str) -> str | None:
    if _STORE_RE.match(warehouse_name or ""):
        return "chemical_store"
    if _CSU_RE.search(warehouse_name or ""):
        return "csu"
    return None


def _csu_age_cohorts(
    item_codes: list[str],
    csu_warehouses: list[str],
    current_qty_by_pair: dict[tuple[str, str], float],
) -> dict[tuple[str, str], list[dict]]:
    """Per-(item, warehouse) FIFO cohorts still present in each CSU.

    Walks ``Stock Ledger Entry`` chronologically over the last
    ``_CSU_AGE_HORIZON_DAYS`` days. Inwards push onto a deposit queue;
    outwards consume from the oldest entry first. Whatever remains in
    the queue at "now" is the current Bin, broken into cohorts by their
    original deposit timestamp.

    Returns a map ``(item_code, warehouse) -> [cohort, ...]`` where each
    cohort is::

        {"added_on": datetime, "qty": float}

    Any (item, warehouse) pair whose queue sum doesn't reconcile with
    the current ``Bin.actual_qty`` is rebalanced by prepending a
    "pre-horizon" cohort timestamped at the horizon cutoff — this
    captures stock that pre-dates our SLE window without losing it.
    """
    if not item_codes or not csu_warehouses or not current_qty_by_pair:
        return {}

    horizon = add_to_date(now_datetime(), days=-_CSU_AGE_HORIZON_DAYS)

    # Opening balance carried INTO the window (stock that pre-dates the horizon),
    # seeded as the OLDEST cohort so in-window outwards consume it FIRST (true
    # FIFO). Without this seed, a large in-window issue that actually drew down
    # pre-horizon stock instead eats the recent in-window RECEIPTS, leaving the
    # genuinely-fresh survivors to be mis-stamped as pre-horizon/expired.
    queues: dict[tuple[str, str], deque] = defaultdict(deque)
    for o in frappe.db.sql(
        """
        SELECT item_code, warehouse, SUM(actual_qty) AS bal
        FROM   `tabStock Ledger Entry`
        WHERE  item_code IN %(items)s
          AND  warehouse IN %(warehouses)s
          AND  is_cancelled = 0
          AND  posting_datetime < %(horizon)s
        GROUP  BY item_code, warehouse
        """,
        {"items": tuple(item_codes), "warehouses": tuple(csu_warehouses),
         "horizon": horizon},
        as_dict=True,
    ):
        bal = float(o["bal"] or 0)
        if bal > _QTY_EPS:
            queues[(o["item_code"], o["warehouse"])].append([horizon, bal, None])

    # Join SLE -> Stock Entry -> Work Order so each inward cohort can
    # carry the destination greenhouse — that's the operator-facing
    # answer to "what was this batch staged for?". The join uses LEFT
    # because some inwards (manual stock entries, opening balances,
    # purchase receipts) have no work order, and we still need to track
    # the qty for FIFO.
    rows = frappe.db.sql(
        """
        SELECT sle.item_code,
               sle.warehouse,
               sle.posting_datetime,
               sle.actual_qty,
               sle.voucher_type,
               sle.voucher_no,
               wo.custom_greenhouse AS greenhouse
        FROM   `tabStock Ledger Entry` sle
        LEFT JOIN `tabStock Entry` se
               ON sle.voucher_type = 'Stock Entry'
              AND sle.voucher_no = se.name
        LEFT JOIN `tabWork Order` wo
               ON se.work_order = wo.name
        WHERE  sle.item_code IN %(items)s
          AND  sle.warehouse IN %(warehouses)s
          AND  sle.posting_datetime >= %(horizon)s
          AND  sle.is_cancelled = 0
        ORDER  BY sle.item_code, sle.warehouse,
                  sle.posting_datetime ASC, sle.creation ASC
        """,
        {
            "items": tuple(item_codes),
            "warehouses": tuple(csu_warehouses),
            "horizon": horizon,
        },
        as_dict=True,
    )

    # queues seeded above with each pair's pre-horizon opening balance.
    for row in rows:
        key = (row["item_code"], row["warehouse"])
        q = queues[key]
        qty = float(row["actual_qty"] or 0)
        if qty >= 0:
            q.append([row["posting_datetime"], qty, row.get("greenhouse")])
        else:
            need = -qty
            while need > _QTY_EPS and q:
                _ts, dq, _gh = q[0]
                if dq <= need + _QTY_EPS:
                    need -= dq
                    q.popleft()
                else:
                    q[0][1] = dq - need
                    need = 0

    out: dict[tuple[str, str], list[dict]] = {}
    for key, current_qty in current_qty_by_pair.items():
        q = queues.get(key, deque())
        q_total = sum(c[1] for c in q)
        diff = current_qty - q_total
        if diff > _QTY_EPS:
            # Pre-horizon stock that consumption never touched — treat
            # as oldest cohort, timestamped at the horizon so the UI can
            # report ">= N days old" without lying about precision. No
            # greenhouse is known for stock that pre-dates our window.
            q.appendleft([horizon, diff, None])
        elif diff < -_QTY_EPS:
            # Outwards exceeded inwards in our window (shouldn't happen
            # because we initialise empty and only consume what we
            # deposited, but defensive). Drop the deficit silently.
            pass
        out[key] = [
            {"added_on": ts, "qty": qty, "greenhouse": gh}
            for ts, qty, gh in q
        ]
    return out


def _summarise_cohorts(
    cohorts: list[dict],
    now: datetime,
) -> tuple[float, float, float, list[dict]]:
    """Return (expired_qty, fresh_qty, oldest_age_days, decorated_cohorts).

    ``decorated_cohorts`` adds ``age_days`` and ``expired`` to each
    cohort so the frontend can render the timeline without recomputing.
    """
    expired_qty = 0.0
    fresh_qty = 0.0
    oldest = 0.0
    decorated: list[dict] = []
    for c in cohorts:
        ts = c["added_on"]
        if not isinstance(ts, datetime):
            ts = get_datetime(ts)
        age_days = (now - ts).total_seconds() / 86400.0
        expired = age_days >= CSU_MAX_AGE_DAYS
        if expired:
            expired_qty += c["qty"]
        else:
            fresh_qty += c["qty"]
        oldest = max(oldest, age_days)
        decorated.append(
            {
                "added_on": ts.isoformat(timespec="seconds"),
                "qty": c["qty"],
                "age_days": round(age_days, 1),
                "expired": expired,
                "greenhouse": c.get("greenhouse"),
            }
        )
    return expired_qty, fresh_qty, round(oldest, 1), decorated


@frappe.whitelist()
def creator_stock_overview() -> dict:
    """Per-warehouse chemical stock for the logged-in Spray Plan Creator.

    Returns:
      {
        "csus":            [{warehouse, farm, total_qty, aged_count, items: [...]}],
        "chemical_stores": [{warehouse, farm, total_qty, items: [...]}],
        "farms":           [...names...],
        "low_stock_count": int,   # chemical stores only
        "aged_csu_count":  int,   # CSU (item, warehouse) pairs aged >= N days
        "csu_max_age_days": int,
        "as_of":           ISO timestamp,
      }

    CSU items carry ``aged: bool``. Chemical store items carry ``low: bool``.
    The two signals are independent and never mixed — a CSU row never has
    a meaningful ``low`` value, and a Chemical Store row never has a
    meaningful ``aged`` value.
    """
    user = frappe.session.user
    if not _user_has_role(user, "SCP Spray Plan Creator"):
        frappe.throw(
            "Only SCP Spray Plan Creator can use this endpoint.",
            frappe.PermissionError,
        )

    scope = _resolve_user_scope(user)
    farms = scope["farms"]
    empty = {
        "csus": [],
        "chemical_stores": [],
        "farms": [],
        "low_stock_count": 0,
        "aged_csu_count": 0,
        "csu_max_age_days": CSU_MAX_AGE_DAYS,
        "as_of": now_datetime().isoformat(timespec="seconds"),
    }
    if not farms:
        return empty

    rows = frappe.db.sql(
        """
        SELECT b.warehouse,
               w.custom_farm                        AS farm,
               b.item_code,
               i.item_name,
               i.item_group,
               COALESCE(i.stock_uom, '')            AS uom,
               COALESCE(ch.low_stock_threshold, fo.low_stock_threshold, 0) AS threshold,
               b.actual_qty                         AS qty
        FROM   `tabBin`       b
        JOIN   `tabWarehouse` w ON w.name = b.warehouse
        JOIN   `tabItem`      i ON i.name = b.item_code
        LEFT JOIN `tabChemical` ch ON ch.item = b.item_code
        LEFT JOIN `tabFoliar`   fo ON fo.item = b.item_code
        WHERE  w.custom_farm IN %(farms)s
          AND  w.disabled = 0
          AND  i.item_group IN %(groups)s
        ORDER  BY w.name, i.item_name
        """,
        {"farms": tuple(farms), "groups": _CHEMICAL_GROUPS},
        as_dict=True,
    )

    csus: dict[str, dict] = {}
    stores: dict[str, dict] = {}
    low_count = 0

    # First pass: classify, build buckets, and collect csu (item, wh)
    # pairs so we can resolve aged-stock in a single batched SLE query.
    csu_pairs: dict[tuple[str, str], float] = {}
    pending_csu_items: list[tuple[dict, dict]] = []  # (warehouse_bucket, item_payload)

    for r in rows:
        bucket_name = _classify(r["warehouse"])
        if not bucket_name:
            continue
        qty = float(r["qty"] or 0)
        if qty <= 0:
            continue
        threshold = float(r["threshold"] or 0)
        is_store = bucket_name == "chemical_store"

        target = stores if is_store else csus
        wh = target.setdefault(
            r["warehouse"],
            {
                "warehouse": r["warehouse"],
                "farm": r["farm"] or "",
                "total_qty": 0.0,
                "items": [],
                **({} if is_store else {"aged_count": 0}),
            },
        )
        wh["total_qty"] += qty

        payload = {
            "item_code": r["item_code"],
            "item_name": r["item_name"] or r["item_code"],
            "group": r["item_group"] or "",
            "uom": r["uom"],
            "qty": qty,
            "threshold": threshold,
        }
        if is_store:
            low = bool(threshold > 0 and qty < threshold)
            payload["low"] = low
            if low:
                low_count += 1
            wh["items"].append(payload)
        else:
            # CSU rows pick up cohort breakdown after the batched SLE
            # query below resolves age. Seed the fields so the shape is
            # always present even for items the walk couldn't reconcile.
            payload["aged"] = False
            payload["expired_qty"] = 0.0
            payload["fresh_qty"] = qty
            payload["oldest_age_days"] = 0.0
            payload["cohorts"] = []
            wh["items"].append(payload)
            csu_pairs[(r["item_code"], r["warehouse"])] = qty
            pending_csu_items.append((wh, payload))

    cohorts_by_pair = _csu_age_cohorts(
        item_codes=list({p[0] for p in csu_pairs.keys()}),
        csu_warehouses=list({p[1] for p in csu_pairs.keys()}),
        current_qty_by_pair=csu_pairs,
    )

    now = now_datetime()
    aged_count = 0
    for wh_bucket, payload in pending_csu_items:
        key = (payload["item_code"], wh_bucket["warehouse"])
        cohorts = cohorts_by_pair.get(key, [])
        expired_qty, fresh_qty, oldest_days, decorated = _summarise_cohorts(
            cohorts, now,
        )
        payload["expired_qty"] = round(expired_qty, 6)
        payload["fresh_qty"] = round(fresh_qty, 6)
        payload["oldest_age_days"] = oldest_days
        payload["cohorts"] = decorated
        payload["aged"] = expired_qty > _QTY_EPS
        if payload["aged"]:
            wh_bucket["aged_count"] += 1
            aged_count += 1

    def _sorted(d: dict) -> list[dict]:
        return sorted(d.values(), key=lambda x: x["warehouse"].lower())

    return {
        "csus": _sorted(csus),
        "chemical_stores": _sorted(stores),
        "farms": farms,
        "low_stock_count": low_count,
        "aged_csu_count": aged_count,
        "csu_max_age_days": CSU_MAX_AGE_DAYS,
        "as_of": now_datetime().isoformat(timespec="seconds"),
    }
