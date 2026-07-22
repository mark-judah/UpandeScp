"""Farm-to-farm chemical loaning.

A farm's Spray Plan Creator requests a chemical from another farm; the source
farm's creator approves, which raises a Material Transfer Stock Entry that
moves the stock (and its valuation) between the two farms' chemical-store
warehouses. Not a repayable loan — an attributed internal transfer.

Spec: docs/superpowers/specs/2026-06-10-chemical-loaning-design.md

No depletion floor: a requester can request any chemical it stocks (including
zero-stock items with a captured Chemical Stock Baseline) from any other farm,
and a lending farm may lend down to zero of its own on-hand — there is no
``loaning_depletion_pct`` gate on visibility or on how much a farm may lend.
Each split is validated purely by ``validate_source_split`` against each
source farm's on-hand.

Cost centers are derived from the warehouses via
``validation.match_cost_center`` (explicit ``Warehouse.custom_cost_center``
first, then the whitespace/case-tolerant name match) — when none resolves we
leave it unset and the company default applies.
"""
from __future__ import annotations

import json
from typing import Any

import frappe
from frappe.utils import add_to_date, flt, get_datetime, now_datetime

from upande_scp.serverscripts.spray_plan_creator.scope import _resolve_user_scope
from upande_scp.serverscripts.spray_plan_creator.validation import match_cost_center
from upande_scp.serverscripts.store.spray_stock_types import SE_TYPE_LOAN

CHEMICAL_GROUPS = ("CHEMICALS", "Fertilizer")
ELEVATED = {"SCP General Manager", "System Manager", "Administrator"}
CREATOR_ROLES = {"SCP Spray Plan Creator"} | ELEVATED
MAX_SOURCES = 5
QTY_TOL = 0.001


def validate_source_split(sources, requested_qty, requesting_farm,
                          lendable_by_farm, max_sources=MAX_SOURCES):
    """Pure validation of a chemical's lender split. Returns an error message
    string, or None if valid. `lendable_by_farm` maps source_farm -> its
    on-hand (the cap). No depletion floor — a lender may lend down to zero."""
    from frappe.utils import flt as _flt
    if not (1 <= len(sources) <= max_sources):
        return f"Pick between 1 and {max_sources} source farm(s)."
    total = 0.0
    for src in sources:
        sf = src.get("source_farm")
        sq = _flt(src.get("qty"))
        if not sf or sq <= 0:
            return "Each source needs a farm and a positive qty."
        if sf == requesting_farm:
            return "A farm cannot loan to itself."
        cap = _flt(lendable_by_farm.get(sf, 0))
        if sq > cap + QTY_TOL:
            return f"{sf} can only lend {cap:g} of this chemical."
        total += sq
    if abs(total - _flt(requested_qty)) > QTY_TOL:
        return f"Source split ({total:g}) must add up to the requested qty ({_flt(requested_qty):g})."
    return None


# ───────────────────────────── guards / scope ────────────────────────────────


def _settings():
    return frappe.get_single("Scouting and Crop Protection Settings")


def _ensure_enabled():
    s = _settings()
    if not s.loaning_enabled:
        frappe.throw(
            "Chemical loaning is not enabled. Ask the SCP General Manager to turn "
            "it on in Settings → Spray Plan.",
        )
    return s


def _ensure_creator():
    if not (set(frappe.get_roles(frappe.session.user)) & CREATOR_ROLES):
        frappe.throw(
            "Chemical loaning requires the SCP Spray Plan Creator role.",
            frappe.PermissionError,
        )


def _user_farms(user: str | None = None) -> set[str] | None:
    """Farms the user may act for, or None for unscoped (GM / admin)."""
    user = user or frappe.session.user
    if set(frappe.get_roles(user)) & ELEVATED:
        return None
    return set(_resolve_user_scope(user).get("farms") or [])


def _assert_farm_access(farm: str) -> None:
    allowed = _user_farms()
    if allowed is None:
        return
    if farm not in allowed:
        frappe.throw(
            f"You are not assigned to {farm}.", frappe.PermissionError
        )


# ───────────────────────────── stock primitives ──────────────────────────────


def _farm_chemical_stores(farm: str) -> list[str]:
    if not farm:
        return []
    return frappe.get_all(
        "Warehouse",
        filters={
            "custom_farm": farm,
            "is_group": 0,
            "disabled": 0,
            "name": ("like", "Chemical Store%"),
        },
        pluck="name",
    )


def _primary_store(farm: str) -> str | None:
    stores = _farm_chemical_stores(farm)
    if not stores:
        return None
    prefix = f"chemical store {farm.lower()}"
    preferred = [s for s in stores if s.lower().startswith(prefix)]
    return (preferred or stores)[0]


def _on_hand(farm: str, item_code: str) -> float:
    stores = _farm_chemical_stores(farm)
    if not stores:
        return 0.0
    row = frappe.db.sql(
        """SELECT COALESCE(SUM(actual_qty), 0) AS q FROM `tabBin`
           WHERE item_code = %s AND warehouse IN %s""",
        (item_code, tuple(stores)),
        as_dict=True,
    )
    return flt(row[0]["q"]) if row else 0.0


def _baseline(farm: str, item_code: str) -> float | None:
    val = frappe.db.get_value(
        "Chemical Stock Baseline", f"{farm}::{item_code}", "baseline_qty"
    )
    return flt(val) if val is not None else None


def _all_chemical_farms() -> list[str]:
    rows = frappe.get_all(
        "Warehouse",
        filters={
            "is_group": 0,
            "disabled": 0,
            "name": ("like", "Chemical Store%"),
            "custom_farm": ("is", "set"),
        },
        fields=["custom_farm"],
        distinct=True,
    )
    return sorted({r.custom_farm for r in rows if r.custom_farm})


# ───────────────────────────────── reads ─────────────────────────────────────


@frappe.whitelist()
def my_farms() -> dict:
    """Farms the current user may request for + feature flag, for the page."""
    _ensure_creator()
    allowed = _user_farms()
    farms = _all_chemical_farms() if allowed is None else sorted(allowed)
    return {"farms": farms, "enabled": bool(_settings().loaning_enabled)}


@frappe.whitelist()
def get_loanable_chemicals(farm: str) -> list[dict]:
    """All candidate chemicals on ``farm`` that could be requested via loaning
    (no depletion gate — any chemical the farm stocks, including zero-stock
    items with a captured baseline)."""
    _ensure_enabled()
    _ensure_creator()
    _assert_farm_access(farm)

    stores = _farm_chemical_stores(farm)
    # Candidate items: anything with stock in the farm's chemical stores, plus
    # anything with a baseline (covers depleted-to-zero items with no Bin row).
    items: dict[str, dict] = {}
    if stores:
        for r in frappe.db.sql(
            """SELECT b.item_code, i.item_name, COALESCE(i.stock_uom,'') uom,
                      COALESCE(SUM(b.actual_qty),0) on_hand
               FROM `tabBin` b JOIN `tabItem` i ON i.name=b.item_code
               WHERE b.warehouse IN %s AND i.item_group IN %s
               GROUP BY b.item_code""",
            (tuple(stores), CHEMICAL_GROUPS),
            as_dict=True,
        ):
            items[r.item_code] = {
                "item_code": r.item_code,
                "item_name": r.item_name or r.item_code,
                "uom": r.uom,
                "on_hand": flt(r.on_hand),
            }
    for b in frappe.get_all(
        "Chemical Stock Baseline",
        filters={"farm": farm},
        fields=["item_code", "item_name", "baseline_qty"],
    ):
        items.setdefault(b.item_code, {
            "item_code": b.item_code,
            "item_name": b.item_name or b.item_code,
            "uom": frappe.db.get_value("Item", b.item_code, "stock_uom") or "",
            "on_hand": _on_hand(farm, b.item_code),
        })

    out = []
    for it in items.values():
        baseline = _baseline(farm, it["item_code"])
        out.append({**it, "baseline_qty": baseline})
    out.sort(key=lambda x: x["item_name"].lower())
    return out


@frappe.whitelist()
def get_sources_for(farm: str, item_code: str) -> list[dict]:
    """Ranked source farms that can lend ``item_code`` to ``farm``. Capped
    only at each candidate's on-hand — no depletion floor."""
    _ensure_enabled()
    _ensure_creator()
    _assert_farm_access(farm)

    out = []
    for src in _all_chemical_farms():
        if src == farm:
            continue
        on_hand = _on_hand(src, item_code)
        lend = on_hand
        if lend > 0:
            out.append({
                "source_farm": src,
                "source_warehouse": _primary_store(src),
                "lendable": lend,
                "on_hand": on_hand,
            })
    out.sort(key=lambda x: x["lendable"], reverse=True)
    return out


@frappe.whitelist()
def list_requests(box: str = "mine") -> list[dict]:
    """``box='mine'`` — requests my farms raised. ``box='incoming'`` — requests
    pending my farms' approval."""
    _ensure_creator()
    farms = _user_farms()

    if box == "incoming":
        filters: dict[str, Any] = {"workflow_state": "Pending Approval"}
        names = frappe.get_all("Chemical Transfer Request", filters=filters, pluck="name")
        rows = [_request_dict(n) for n in names]
        if farms is not None:
            rows = [
                r for r in rows
                if any(s["source_farm"] in farms and not s["approved"] for s in r["sources"])
            ]
        return rows

    filters = {}
    if farms is not None:
        filters["requesting_farm"] = ("in", list(farms) or [""])
    names = frappe.get_all(
        "Chemical Transfer Request",
        filters=filters,
        order_by="creation desc",
        limit_page_length=200,
        pluck="name",
    )
    return [_request_dict(n) for n in names]


@frappe.whitelist()
def get_creditors(farm) -> list[dict]:
    """Read-only: for the borrowing `farm`, what it received and from whom —
    approved loan sources grouped by (lending farm, chemical)."""
    _ensure_enabled()
    _ensure_creator(); _assert_farm_access(farm)
    rows = frappe.db.sql(
        """SELECT s.source_farm AS creditor_farm, r.item_code, r.item_name, r.uom,
                  SUM(s.qty) AS qty
           FROM `tabChemical Transfer Request Source` s
           JOIN `tabChemical Transfer Request` r ON r.name = s.parent
           WHERE r.requesting_farm = %(farm)s AND s.approved = 1
           GROUP BY s.source_farm, r.item_code
           ORDER BY r.item_name, s.source_farm""",
        {"farm": farm}, as_dict=True)
    return rows


def _request_dict(name: str) -> dict:
    doc = frappe.get_doc("Chemical Transfer Request", name)
    return {
        "name": doc.name,
        "requesting_farm": doc.requesting_farm,
        "requesting_warehouse": doc.requesting_warehouse,
        "item_code": doc.item_code,
        "item_name": doc.item_name,
        "uom": doc.uom,
        "requested_qty": flt(doc.requested_qty),
        "workflow_state": doc.workflow_state,
        "reason": doc.reason,
        "rejected_reason": doc.rejected_reason,
        "expires_on": str(doc.expires_on) if doc.expires_on else None,
        "creation": str(doc.creation),
        "sources": [
            {
                "source_farm": s.source_farm,
                "source_warehouse": s.source_warehouse,
                "qty": flt(s.qty),
                "approved": bool(s.approved),
                "approved_by": s.approved_by,
                "approved_on": str(s.approved_on) if s.approved_on else None,
                "stock_entry": s.stock_entry,
            }
            for s in doc.sources
        ],
    }


# ──────────────────────────────── writes ─────────────────────────────────────


def _create_one(farm, reason, item, settings):
    """Create one Chemical Transfer Request for a single chemical. `item` =
    {item_code, uom?, requested_qty, sources:[{source_farm, qty}]}. Returns name."""
    item_code = item.get("item_code")
    requested_qty = flt(item.get("requested_qty"))
    sources = item.get("sources") or []
    if not item_code or requested_qty <= 0:
        frappe.throw("item_code and a positive requested_qty are required.")
    # cap = each source farm's on-hand (no floor)
    lendable = {s.get("source_farm"): _on_hand(s.get("source_farm"), item_code)
                for s in sources if s.get("source_farm")}
    err = validate_source_split(sources, requested_qty, farm, lendable)
    if err:
        frappe.throw(err)

    timeout_h = int(settings.loaning_timeout_hours or 72)
    doc = frappe.new_doc("Chemical Transfer Request")
    doc.requesting_farm = farm
    doc.requesting_warehouse = _primary_store(farm)
    doc.item_code = item_code
    doc.item_name = frappe.db.get_value("Item", item_code, "item_name")
    doc.uom = item.get("uom") or frappe.db.get_value("Item", item_code, "stock_uom")
    doc.requested_qty = requested_qty
    doc.reason = reason
    doc.workflow_state = "Pending Approval"
    doc.expires_on = add_to_date(now_datetime(), hours=timeout_h)
    for src in sources:
        doc.append("sources", {
            "source_farm": src.get("source_farm"),
            "source_warehouse": _primary_store(src.get("source_farm")),
            "qty": flt(src.get("qty")),
        })
    doc.insert(ignore_permissions=True)
    for src in doc.sources:
        _notify_farm_creators(
            src.source_farm,
            f"Chemical loan request {doc.name} — {doc.item_name}",
            f"{farm} requests {flt(src.qty):g} {doc.uom} of {doc.item_name}. Approve in Chemical Loaning.",
            doc.name,
        )
    return doc.name


@frappe.whitelist()
def create_request(payload) -> dict:
    """Single-chemical request (kept for backward compat)."""
    s = _ensure_enabled(); _ensure_creator()
    if isinstance(payload, str):
        payload = json.loads(payload)
    farm = payload.get("requesting_farm")
    _assert_farm_access(farm)
    name = _create_one(farm, payload.get("reason"), {
        "item_code": payload.get("item_code"),
        "uom": payload.get("uom"),
        "requested_qty": payload.get("requested_qty"),
        "sources": payload.get("sources") or [],
    }, s)
    return {"name": name}


@frappe.whitelist()
def create_requests(payload) -> dict:
    """Batch: one Chemical Transfer Request per chemical.
    payload = {requesting_farm, reason, items: [{item_code, uom, requested_qty,
    sources:[{source_farm, qty}]}]}. One bad chemical doesn't abort the rest."""
    s = _ensure_enabled(); _ensure_creator()
    if isinstance(payload, str):
        payload = json.loads(payload)
    farm = payload.get("requesting_farm")
    _assert_farm_access(farm)
    items = payload.get("items") or []
    if not items:
        frappe.throw("Add at least one chemical.")
    names, failed = [], []
    for idx, it in enumerate(items):
        sp = f"loan_item_{idx}"
        frappe.db.savepoint(sp)
        try:
            names.append(_create_one(farm, payload.get("reason"), it, s))
        except Exception as e:
            frappe.db.rollback(save_point=sp)
            failed.append({"item_code": it.get("item_code"), "error": str(e)})
    frappe.db.commit()
    return {"names": names, "failed": failed}


@frappe.whitelist()
def approve_source(request: str, source_farm: str) -> dict:
    """Source-side approval of one split row. On full approval, raise the
    Material Transfer Stock Entry(s) and mark the request Fulfilled."""
    _ensure_enabled()
    _ensure_creator()
    _assert_farm_access(source_farm)

    doc = frappe.get_doc("Chemical Transfer Request", request)
    if doc.workflow_state not in ("Pending Approval", "Approved"):
        frappe.throw(f"Request is {doc.workflow_state} — cannot approve.")

    row = next((s for s in doc.sources if s.source_farm == source_farm), None)
    if not row:
        frappe.throw(f"{source_farm} is not a source on this request.")
    if not row.approved:
        row.approved = 1
        row.approved_by = frappe.utils.get_fullname(frappe.session.user)
        row.approved_on = now_datetime()

    if all(s.approved for s in doc.sources):
        doc.workflow_state = "Approved"
        doc.save(ignore_permissions=True)
        for s in doc.sources:
            if not s.stock_entry:
                s.stock_entry = _make_transfer_se(doc, s)
        doc.workflow_state = "Fulfilled"
        doc.save(ignore_permissions=True)
        _notify_user(
            frappe.db.get_value("Chemical Transfer Request", doc.name, "owner"),
            f"Chemical loan {doc.name} fulfilled",
            f"Your request for {doc.item_name} was approved and transferred.",
            doc.name,
        )
    else:
        doc.save(ignore_permissions=True)

    return _request_dict(doc.name)


@frappe.whitelist()
def reject_request(request: str, reason: str | None = None) -> dict:
    _ensure_enabled()
    _ensure_creator()
    doc = frappe.get_doc("Chemical Transfer Request", request)
    # Caller must own at least one source farm on the request.
    farms = _user_farms()
    if farms is not None and not any(s.source_farm in farms for s in doc.sources):
        frappe.throw("You cannot reject this request.", frappe.PermissionError)
    if doc.workflow_state not in ("Pending Approval", "Approved"):
        frappe.throw(f"Request is {doc.workflow_state} — cannot reject.")
    doc.workflow_state = "Rejected"
    doc.rejected_reason = reason
    doc.save(ignore_permissions=True)
    _notify_user(
        frappe.db.get_value("Chemical Transfer Request", doc.name, "owner"),
        f"Chemical loan {doc.name} rejected",
        f"Your request for {doc.item_name} was rejected." + (f" Reason: {reason}" if reason else ""),
        doc.name,
    )
    return _request_dict(doc.name)


def _make_transfer_se(doc, src_row) -> str:
    """Material Transfer SE moving src_row.qty from the source farm's chemical
    store to the requesting farm's store. Valuation moves with the stock."""
    src_wh = src_row.source_warehouse
    tgt_wh = doc.requesting_warehouse
    if not src_wh or not tgt_wh:
        frappe.throw(
            f"Missing chemical-store warehouse for the transfer "
            f"({src_row.source_farm} → {doc.requesting_farm})."
        )
    company = frappe.db.get_value("Warehouse", src_wh, "company")
    # Cost center via the existing fuzzy derivation; target's first, else source.
    cc = match_cost_center(tgt_wh) or match_cost_center(src_wh)

    se = frappe.new_doc("Stock Entry")
    se.stock_entry_type = SE_TYPE_LOAN
    se.purpose = "Material Transfer"
    se.company = company
    se.from_warehouse = src_wh
    se.to_warehouse = tgt_wh
    se.append("items", {
        "item_code": doc.item_code,
        "qty": flt(src_row.qty),
        "uom": doc.uom,
        "s_warehouse": src_wh,
        "t_warehouse": tgt_wh,
        "cost_center": cc,
    })
    se.flags.ignore_permissions = True
    se.insert()
    se.submit()
    return se.name


# ───────────────────────────── baselines / restock ───────────────────────────


def capture_baseline_on_receipt(doc, method=None):
    """Hooked on inbound stock movements. When chemicals are received into a
    farm's chemical store, set that (farm, chemical) baseline to the new
    on-hand. Tolerant of doc shape (Stock Entry / Purchase Receipt)."""
    try:
        if not _settings().loaning_enabled:
            return
    except Exception:
        return

    # Collect (warehouse, item_code) pairs that received stock.
    pairs: set[tuple[str, str]] = set()
    for it in (getattr(doc, "items", None) or []):
        wh = getattr(it, "t_warehouse", None) or getattr(it, "warehouse", None)
        code = getattr(it, "item_code", None)
        if wh and code:
            pairs.add((wh, code))

    for wh, code in pairs:
        farm = frappe.db.get_value("Warehouse", wh, "custom_farm")
        if not farm:
            continue
        if not str(wh).lower().startswith("chemical store"):
            continue
        group = frappe.db.get_value("Item", code, "item_group")
        if group not in CHEMICAL_GROUPS:
            continue
        _upsert_baseline(farm, code, _on_hand(farm, code), "restock")


def _upsert_baseline(farm: str, item_code: str, qty: float, via: str) -> None:
    name = f"{farm}::{item_code}"
    if frappe.db.exists("Chemical Stock Baseline", name):
        frappe.db.set_value("Chemical Stock Baseline", name, {
            "baseline_qty": qty,
            "captured_on": now_datetime(),
            "captured_via": via,
        }, update_modified=True)
    else:
        b = frappe.new_doc("Chemical Stock Baseline")
        b.farm = farm
        b.item_code = item_code
        b.item_name = frappe.db.get_value("Item", item_code, "item_name")
        b.baseline_qty = qty
        b.captured_on = now_datetime()
        b.captured_via = via
        b.insert(ignore_permissions=True)


@frappe.whitelist()
def bulk_restock(farm: str | None = None) -> dict:
    """GM utility: set every (farm, chemical) baseline to current on-hand."""
    if not (set(frappe.get_roles(frappe.session.user)) & ELEVATED):
        frappe.throw("Only the SCP General Manager can bulk-restock.", frappe.PermissionError)

    farms = [farm] if farm else _all_chemical_farms()
    updated = 0
    for f in farms:
        stores = _farm_chemical_stores(f)
        if not stores:
            continue
        rows = frappe.db.sql(
            """SELECT b.item_code, COALESCE(SUM(b.actual_qty),0) q
               FROM `tabBin` b JOIN `tabItem` i ON i.name=b.item_code
               WHERE b.warehouse IN %s AND i.item_group IN %s AND b.actual_qty > 0
               GROUP BY b.item_code""",
            (tuple(stores), CHEMICAL_GROUPS),
            as_dict=True,
        )
        for r in rows:
            _upsert_baseline(f, r.item_code, flt(r.q), "bulk_restock")
            updated += 1
    frappe.db.commit()
    return {"farms": len(farms), "baselines_set": updated}


# ───────────────────────────────── timeout job ───────────────────────────────


def expire_dormant_requests() -> dict:
    """Hourly: expire Pending Approval requests past their timeout."""
    try:
        if not _settings().loaning_enabled:
            return {"enabled": False, "expired": []}
    except Exception:
        return {"enabled": False, "expired": []}

    now = now_datetime()
    pending = frappe.get_all(
        "Chemical Transfer Request",
        filters={"workflow_state": "Pending Approval"},
        fields=["name", "expires_on", "owner", "item_name"],
    )
    expired = []
    for r in pending:
        if r.expires_on and get_datetime(r.expires_on) < now:
            try:
                frappe.db.set_value(
                    "Chemical Transfer Request", r.name, "workflow_state", "Expired"
                )
                _notify_user(
                    r.owner,
                    f"Chemical loan {r.name} expired",
                    f"Your request for {r.item_name} expired with no response.",
                    r.name,
                )
                frappe.db.commit()
                expired.append(r.name)
            except Exception:
                frappe.db.rollback()
                frappe.log_error(frappe.get_traceback(), f"expire_dormant_requests: {r.name}")
    return {"enabled": True, "expired": expired}


# ───────────────────────────────── notifications ─────────────────────────────


def _notify_farm_creators(farm: str, subject: str, content: str, ref: str) -> None:
    users = frappe.get_all(
        "Farm Spray Plan Creator",
        filters={"parent": farm, "parenttype": "Farm"},
        pluck="user",
    )
    for u in set(users):
        _notify_user(u, subject, content, ref)
    frappe.publish_realtime("chemical_loaning", {"request": ref}, after_commit=True)


def _notify_user(user: str | None, subject: str, content: str, ref: str) -> None:
    if not user or user in ("Administrator", "Guest"):
        return
    try:
        frappe.get_doc({
            "doctype": "Notification Log",
            "for_user": user,
            "type": "Alert",
            "subject": subject,
            "email_content": content,
            "document_type": "Chemical Transfer Request",
            "document_name": ref,
        }).insert(ignore_permissions=True)
    except Exception:
        frappe.log_error(frappe.get_traceback(), "loaning notify failed")
