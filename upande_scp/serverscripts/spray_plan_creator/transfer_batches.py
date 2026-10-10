"""Which batches a tank-mix Manufacture consumes: the ones transferred in for its plan.

Before this, the Manufacture rows named no batch and ERPNext picked one itself, first in
first out over every batch in the CSU. The CSU is shared, so that pick usually landed on
another plan's batch, failed on an expired batch that was physically in the tank, or found
nothing at all for a legacy transfer that carried no batch.

The rule now, decided on the server for the online button and the offline replay alike:

1. **The plan's own lots first.** The lots are read from the stock ledger: the inward
   entries of the plan's submitted Material Transfer for Manufacture into its CSU, with the
   batch taken from the Serial and Batch Bundle (the transfer row's ``batch_no`` is set only
   sometimes, so it is not used). Oldest transfer first. Each lot gives
   ``min(what is still needed, the lot's qty, what that batch still holds in the CSU)``.
2. **A legacy lot with no batch** takes from the item's ``-PREMIGRATION`` placeholder batch
   in the CSU, which is what that unbatched stock became.
3. **Anything still short** comes from the other batches holding stock in the CSU, oldest
   batch first, and each such take is written down as a note. Field work is not refused
   because the transferred batch is short; it is refused only when the CSU cannot cover the
   chemical at all.

"What a batch holds" for a posting at moment *t* is the lowest running balance of that
batch in the CSU from *t* onward, not the balance at *t*. An offline session replayed days
later is posted back at its mix time; consuming the balance as it stood then would push a
later entry negative.

`plan_item` is pure (plain dicts in, plain dicts out) so the rule can be tested without a
ledger. The ledger reads sit around it.
"""
from __future__ import annotations

from typing import Any

import frappe
from frappe.utils import flt, get_datetime, now_datetime

TRANSFER_PURPOSE = "Material Transfer for Manufacture"

#: Below this a quantity is rounding, not stock.
EPS = 1e-9

#: What the v15 -> v16 migration stamped on the opening-stock batches it invented for
#: stock that had no batch. Reimplemented here on purpose rather than imported from the
#: store's batch_suggestion module, so the two can change independently.
PLACEHOLDER_MARKER = "PREMIGRATION"

SOURCE_TRANSFERRED = "transferred"
SOURCE_PLACEHOLDER = "placeholder"
SOURCE_FALLBACK = "fallback"


def is_placeholder(batch_no) -> bool:
    return PLACEHOLDER_MARKER in str(batch_no or "").upper()


# ─────────────────────────────── the pure rule ───────────────────────────────


def plan_item(
    need: float,
    lots: list[dict],
    available: dict[str, float],
    order: list[str],
    placeholder: str | None = None,
) -> dict[str, Any]:
    """Split ``need`` across batches.

    ``lots``: this plan's transfers of the item, oldest first, each ``{batch_no, qty}``;
    ``batch_no`` is None for a legacy transfer that carried no batch.
    ``available``: batch -> qty that can be consumed at the posting moment.
    ``order``: every batch with stock in the CSU, oldest batch first (the fallback order).
    ``placeholder``: the item's placeholder batch in the CSU, if it has one.

    Returns ``{"pieces": [{batch_no, qty, source}], "fallback": [{batch_no, qty}],
    "legacy": [{batch_no, qty}] (placeholder takes for unbatched lots), "short": qty not
    covered}``. Pieces are merged per batch, in the order first taken.
    """
    remaining = flt(need)
    left = {b: max(flt(q), 0.0) for b, q in (available or {}).items()}
    pieces: dict[str, dict] = {}
    fallback: list[dict] = []
    legacy: list[dict] = []
    transferred = {l.get("batch_no") for l in lots or [] if l.get("batch_no")}

    def take(batch_no, qty, source):
        nonlocal remaining
        qty = min(qty, left.get(batch_no, 0.0), remaining)
        if qty <= EPS:
            return 0.0
        left[batch_no] = left.get(batch_no, 0.0) - qty
        remaining -= qty
        if batch_no in pieces:
            pieces[batch_no]["qty"] += qty
        else:
            pieces[batch_no] = {"batch_no": batch_no, "qty": qty, "source": source}
        return qty

    # 1 + 2: the plan's own lots, oldest transfer first.
    for lot in lots or []:
        if remaining <= EPS:
            break
        want = flt(lot.get("qty"))
        if lot.get("batch_no"):
            take(lot["batch_no"], want, SOURCE_TRANSFERRED)
        elif placeholder:
            got = take(placeholder, want, SOURCE_PLACEHOLDER)
            if got > EPS:
                legacy.append({"batch_no": placeholder, "qty": got})

    # 3: whatever is still short, from the rest of the CSU, oldest batch first. A batch the
    # plan did transfer is still its own batch even past the lot's qty; anything else is
    # recorded as a fallback.
    for batch_no in order or []:
        if remaining <= EPS:
            break
        is_own = batch_no in transferred
        got = take(
            batch_no,
            remaining,
            SOURCE_TRANSFERRED if is_own else SOURCE_FALLBACK,
        )
        if got > EPS and not is_own:
            fallback.append({"batch_no": batch_no, "qty": got})

    return {
        "pieces": list(pieces.values()),
        "fallback": fallback,
        "legacy": legacy,
        "short": remaining if remaining > EPS else 0.0,
    }


def balance_floor(movements: list[dict], moment) -> dict[str, float]:
    """batch -> the lowest running balance from ``moment`` onward.

    ``movements`` are signed ledger qtys per batch, in posting order. Everything posted at
    or before ``moment`` makes up the opening balance; every later movement can only lower
    what may be taken at ``moment`` without a later entry going negative.
    """
    moment = get_datetime(moment) if moment else now_datetime()
    bal: dict[str, float] = {}
    floor: dict[str, float] = {}
    started: set[str] = set()
    for m in movements or []:
        b = m["batch_no"]
        when = get_datetime(m["posting_datetime"])
        bal[b] = bal.get(b, 0.0) + flt(m["qty"])
        if when <= moment:
            floor[b] = bal[b]
        else:
            if b not in started:
                started.add(b)
                floor.setdefault(b, bal[b] - flt(m["qty"]))
            floor[b] = min(floor[b], bal[b])
    return {b: max(q, 0.0) for b, q in floor.items()}


# ─────────────────────────────── ledger reads ────────────────────────────────


def transferred_lots(work_order: str, wip: str) -> list[dict]:
    """The plan's transferred lots into its CSU, oldest transfer first.

    One row per (inward ledger entry, batch). ``batch_no`` is None for a legacy transfer
    whose ledger entry carried no batch.
    """
    rows = frappe.db.sql(
        """SELECT sle.voucher_no, sle.posting_datetime, sle.creation, sle.item_code,
                  COALESCE(sbe.batch_no, NULLIF(sle.batch_no, '')) AS batch_no,
                  COALESCE(sbe.qty, sle.actual_qty) AS qty
           FROM `tabStock Ledger Entry` sle
           JOIN `tabStock Entry` se ON se.name = sle.voucher_no
           LEFT JOIN `tabSerial and Batch Entry` sbe
             ON sbe.parent = sle.serial_and_batch_bundle
           WHERE se.work_order = %s AND se.purpose = %s AND se.docstatus = 1
             AND sle.voucher_type = 'Stock Entry' AND sle.is_cancelled = 0
             AND sle.warehouse = %s AND sle.actual_qty > 0
           ORDER BY sle.posting_datetime, sle.creation, sbe.idx""",
        (work_order, TRANSFER_PURPOSE, wip),
        as_dict=True,
    )
    return [
        {
            "item_code": r.item_code,
            "batch_no": r.batch_no or None,
            "qty": flt(r.qty),
            "voucher_no": r.voucher_no,
            "posting_datetime": r.posting_datetime,
        }
        for r in rows
        if flt(r.qty) > 0
    ]


def batch_movements(item_code: str, warehouse: str) -> list[dict]:
    """Every batch movement of an item in a warehouse, in posting order."""
    return frappe.db.sql(
        """SELECT sle.posting_datetime, sle.creation,
                  COALESCE(sbe.batch_no, NULLIF(sle.batch_no, '')) AS batch_no,
                  COALESCE(sbe.qty, sle.actual_qty) AS qty
           FROM `tabStock Ledger Entry` sle
           LEFT JOIN `tabSerial and Batch Entry` sbe
             ON sbe.parent = sle.serial_and_batch_bundle
           WHERE sle.is_cancelled = 0 AND sle.item_code = %s AND sle.warehouse = %s
             AND COALESCE(sbe.batch_no, NULLIF(sle.batch_no, '')) IS NOT NULL
           ORDER BY sle.posting_datetime, sle.creation""",
        (item_code, warehouse),
        as_dict=True,
    )


def is_batch_item(item_code: str) -> bool:
    return bool(frappe.get_cached_value("Item", item_code, "has_batch_no"))


def resolve_item(
    work_order: str, wip: str, item_code: str, need: float, moment=None, lots=None
) -> dict[str, Any]:
    """The batches one chemical of one plan is consumed from, read off the ledger."""
    if lots is None:
        lots = [l for l in transferred_lots(work_order, wip) if l["item_code"] == item_code]
    available = balance_floor(batch_movements(item_code, wip), moment)
    with_stock = [b for b, q in available.items() if q > EPS]
    meta = {}
    if with_stock:
        for r in frappe.get_all(
            "Batch",
            filters={"name": ["in", with_stock]},
            fields=["name", "creation", "expiry_date"],
        ):
            meta[r.name] = r
    order = sorted(
        with_stock,
        key=lambda b: (str(meta[b].creation) if b in meta else "9999", b),
    )
    placeholder = next(
        (b for b in order if is_placeholder(b)), None
    )
    plan = plan_item(need, lots, available, order, placeholder)
    plan["available_total"] = sum(available[b] for b in with_stock)
    plan["expiry"] = {b: (meta[b].expiry_date if b in meta else None) for b in with_stock}
    return plan


def resolve_consumption(
    work_order: str, wip: str, needs: dict[str, float], moment=None
) -> dict[str, dict]:
    """item -> plan, for every batch-tracked item in ``needs``. Others are left out."""
    lots = transferred_lots(work_order, wip)
    out = {}
    for item_code, need in needs.items():
        if flt(need) <= 0 or not is_batch_item(item_code):
            continue
        out[item_code] = resolve_item(
            work_order, wip, item_code, need, moment,
            lots=[l for l in lots if l["item_code"] == item_code],
        )
    return out


def fallback_note(item_code: str, batch_no: str, qty: float) -> str:
    return (
        f"took {flt(qty):g} of {item_code} from batch {batch_no} — "
        "not transferred for this WO"
    )


def placeholder_note(item_code: str, batch_no: str, qty: float) -> str:
    return (
        f"took {flt(qty):g} of {item_code} from placeholder batch {batch_no} — "
        "the transfer for this WO carried no batch"
    )


def notes_for(item_code: str, plan: dict) -> list[str]:
    notes = [fallback_note(item_code, f["batch_no"], f["qty"]) for f in plan.get("fallback") or []]
    for p in plan.get("legacy") or []:
        notes.append(placeholder_note(item_code, p["batch_no"], p["qty"]))
    return notes
