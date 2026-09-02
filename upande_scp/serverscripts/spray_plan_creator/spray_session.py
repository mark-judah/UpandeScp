"""CSU scan + spray session endpoints for Application Floor Plan Work Orders.

This module owns the per-WO lifecycle transitions Part B introduced. All
endpoints serialise concurrent callers with ``SELECT ... FOR UPDATE`` on the
Work Order row so the "last-chemical-scanned" promotion to Tank Mix Manufactured
is exactly-once.

Endpoints:
  * ``register_csu_scan`` — mobile per-chemical scan. Idempotent on
    ``(work_order, item_code)``. On the final scan, creates+submits a
    Manufacture Stock Entry and a draft Spray Application Logsheet, and
    flips the WO to ``Tank Mix Manufactured``.
  * ``start_spray_session`` — opens a Sprayer Movement Session, stamps the
    SAL's application_start_time, flips the WO to ``Spraying In Progress``.
  * ``end_spray_session`` — fires Material Issue (via
    ``auto_material_issue.build_and_submit_material_issue``), submits SAL,
    closes the SMS, flips the WO to ``Completed``.
"""
from __future__ import annotations

import json
from typing import Any

import frappe
from frappe.utils import flt, get_datetime, now_datetime, today

from upande_scp.serverscripts.common.timezone import to_site_naive
from upande_scp.serverscripts.spray_plan_ops.spray_plan_approval import (
    _derive_farm,
    _patch_zero_rates,
)
from upande_scp.serverscripts.spray_plan_creator.auto_material_issue import (
    build_and_submit_material_issue,
    resolve_supervisor_employee,
)
from upande_scp.serverscripts.spray_plan_creator.quantities import absolute_to_rate
from upande_scp.serverscripts.spray_plan_creator.validation import match_cost_center
from upande_scp.serverscripts.store.spray_stock_types import SE_TYPE_MIX

AFP_TYPE = "Application Floor Plan"

STATE_APPROVED = "Approved"
STATE_CHEMICAL_ISSUED = "Chemical Issued"
STATE_TANK_MIX_MANUFACTURED = "Tank Mix Manufactured"
STATE_SPRAYING_IN_PROGRESS = "Spraying In Progress"
STATE_COMPLETED = "Completed"


# ─────────────────────────────── shared helpers ──────────────────────────────


def _lock_wo(wo_name: str) -> str:
    """Row-lock the WO and return its current workflow_state."""
    row = frappe.db.sql(
        "SELECT name, workflow_state FROM `tabWork Order` WHERE name=%s FOR UPDATE",
        (wo_name,),
        as_dict=True,
    )
    if not row:
        frappe.throw(f"Work Order {wo_name} not found.")
    return row[0]["workflow_state"] or ""


def _ensure_afp(wo) -> None:
    if getattr(wo, "custom_type", None) != AFP_TYPE:
        frappe.throw(
            f"Work Order {wo.name} is not an Application Floor Plan WO "
            f"(custom_type={wo.custom_type!r})."
        )


def _resolve_employee_from_session(employee: str | None = None) -> str:
    """Find the Employee to credit a scan to. Throws if there is none.

    ``employee`` names who actually took the chemical, for a session recorded offline and
    replayed later. Without it the scan is credited to whoever pressed Sync — which for a
    replayed session is the wrong person, and may be a different person entirely.
    """
    if employee and frappe.db.exists(
        "Employee", {"name": employee, "status": "Active"}
    ):
        return employee
    user = frappe.session.user
    if user and user not in ("Guest", "Administrator"):
        emp = frappe.db.get_value(
            "Employee",
            {"user_id": user, "status": "Active"},
            "name",
            order_by="modified DESC",
        )
        if emp:
            return emp
    frappe.throw(
        f"No active Employee linked to user {frappe.session.user!r}. "
        "Link the user to an Employee record to record scans."
    )


def _required_chemical_codes(wo) -> set[str]:
    """Distinct item_codes from wo.required_items (the chemicals to scan)."""
    return {
        r.item_code
        for r in (wo.required_items or [])
        if getattr(r, "item_code", None)
    }


def _scanned_codes(wo) -> set[str]:
    return {
        s.item_code
        for s in (getattr(wo, "custom_chemical_scans", None) or [])
        if getattr(s, "item_code", None)
    }


# ──────────────────────── scan-verification method ───────────────────────────

SCAN_METHOD_LABELS = "labels"
SCAN_METHOD_TICK = "tick"

_SETTINGS = "Scouting and Crop Protection Settings"


@frappe.whitelist()
def get_scan_verification_method() -> dict[str, str]:
    """How a sprayer confirms each chemical taken from the CSU.

    ``labels`` (the default) requires scanning the printed QR label; ``tick``
    lets the sprayer tick to confirm instead, for farms where label printing
    isn't available.

    Read-only and callable by any signed-in user: every sprayer's chemical
    screen needs it to decide which control to render. Anything unrecognised
    or unset resolves to ``labels``, so a missing or garbled setting fails
    closed — toward requiring the scan, never toward skipping it.

    Writes go through the one existing path, ``settings.save_spray_plan_settings``
    (Settings → Spray Plan), which is already gated to the GM / System Manager
    and, because the field is a Select, has Frappe reject any value other than
    the two valid ones. Deliberately no setter here: a second write path for one
    field is how the two ends drift apart.
    """
    configured = frappe.db.get_single_value(_SETTINGS, "csu_scan_verification")
    method = (
        SCAN_METHOD_TICK
        if (configured or "").strip().lower() == SCAN_METHOD_TICK
        else SCAN_METHOD_LABELS
    )
    return {"method": method}


def _verify_qr(qr_payload, work_order: str, item_code: str) -> dict[str, Any]:
    """Verify a scanned label, or explain why it could not be.

    Refuses (throws) when the payload IS a traceable code but fails a check — a wrong
    plan, a cancelled transfer, a code that was never issued. Returns
    ``verified=False`` for a legacy text payload, which cannot be checked at all:
    those stickers are already in circulation and refusing them would stop work on
    the day this ships. The distinction is recorded on the scan row so the audit trail
    never claims a legacy scan proved something.
    """
    from upande_scp.serverscripts.qr import chemical_labels

    try:
        return chemical_labels.verify_scan(qr_payload, work_order, item_code)
    except chemical_labels.ScanRefused as e:
        frappe.throw(str(e), frappe.ValidationError)
    except Exception:
        # A fault in verification must not become a refusal to work; it is logged and
        # the scan is recorded as unverified.
        frappe.log_error(frappe.get_traceback(), "Chemical QR – verify failed")
        return {"verified": False, "why": "label check unavailable"}


# ───────────────────────────── register_csu_scan ─────────────────────────────


@frappe.whitelist()
def register_csu_scan(
    work_order: str,
    item_code: str,
    qr_payload: str | None = None,
    csu_warehouse: str | None = None,
    gps_lat: float | None = None,
    gps_lon: float | None = None,
    scanned_at=None,
    employee: str | None = None,
) -> dict[str, Any]:
    """Upsert one chemical's scan row on a Work Order.

    Idempotent on (work_order, item_code) — re-scans update ``scanned_at`` and
    ``scanned_by``. When the last required chemical is scanned AND the WO is
    currently in ``Chemical Issued``, this call additionally:

      1. Builds + submits a Manufacture Stock Entry against the WO.
      2. Creates a draft Spray Application Logsheet linked back to the WO.
      3. Flips the WO to ``Tank Mix Manufactured``.

    Concurrent callers are serialised on the WO row, so the promotion is
    exactly-once.
    """
    if not work_order or not item_code:
        frappe.throw("work_order and item_code are required.")

    current_state = _lock_wo(work_order)
    wo = frappe.get_doc("Work Order", work_order)
    _ensure_afp(wo)

    required = _required_chemical_codes(wo)
    if item_code not in required:
        frappe.throw(
            f"Item {item_code} is not in this Work Order's required chemicals."
        )

    # Check the label against the transfer it came from. Until this existed the
    # payload was stored and never read, so the only test was that `item_code` — sent
    # by the client, alongside the scan — appeared on the WO: a label from another
    # greenhouse passed, and so did a typed code with no scan at all.
    verification = _verify_qr(qr_payload, work_order, item_code)

    employee = _resolve_employee_from_session(employee)
    # `scanned_at` is the moment the label was actually scanned, for a session recorded
    # offline. It dates the audit row only — the Manufacture is a separate explicit step
    # (`manufacture_tank_mix`), which takes its own posting moment.
    now = to_site_naive(scanned_at) or now_datetime()

    # Upsert on (work_order, item_code) via direct child-row operations. We
    # deliberately avoid ``wo.save()`` here — the WO is docstatus=1 and a full
    # save retriggers ERPNext's manufacturing validations even with the
    # ignore-update-after-submit flag, which is the wrong tool for what is
    # essentially an audit-log append.
    existing_name = frappe.db.get_value(
        "Work Order Chemical Scan",
        {
            "parent": wo.name,
            "parenttype": "Work Order",
            "parentfield": "custom_chemical_scans",
            "item_code": item_code,
        },
        "name",
    )

    payload: dict[str, Any] = {
        "scanned_by": employee,
        "scanned_at": now,
    }
    if csu_warehouse:
        payload["csu_warehouse"] = csu_warehouse
    if qr_payload:
        payload["qr_payload"] = qr_payload
    payload["qr_verified"] = 1 if verification.get("verified") else 0
    if gps_lat is not None:
        payload["gps_lat"] = flt(gps_lat)
    if gps_lon is not None:
        payload["gps_lon"] = flt(gps_lon)

    if existing_name:
        frappe.db.set_value(
            "Work Order Chemical Scan", existing_name, payload,
            update_modified=True,
        )
    else:
        child = frappe.get_doc({
            "doctype": "Work Order Chemical Scan",
            "parent": wo.name,
            "parenttype": "Work Order",
            "parentfield": "custom_chemical_scans",
            "item_code": item_code,
            **payload,
        })
        child.flags.ignore_permissions = True
        child.insert()

    # Reload so the scan list reflects the upsert.
    wo = frappe.get_doc("Work Order", wo.name)
    scanned = _scanned_codes(wo)
    all_scanned = required.issubset(scanned)

    response: dict[str, Any] = {
        "workflow_state": current_state,
        "all_scanned": all_scanned,
        "scanned": sorted(scanned),
        "qr_verified": bool(verification.get("verified")),
    }
    if verification.get("why"):
        # Surfaced rather than swallowed: a sprayer scanning an old label should be
        # told why it could not be verified, not left thinking it was.
        response["qr_note"] = verification["why"]

    # Manufacture is now an EXPLICIT step (see ``manufacture_tank_mix``), not a
    # side effect of the last scan. Decoupling the two means there is exactly
    # one manufacture trigger — eliminating the double-manufacture risk — and
    # lets the supervisor confirm the spray team before confirming the tank
    # mix. Scanning here only records the audit row. If the WO has *already*
    # been manufactured, surface the existing SE/SAL so the mobile converges.
    if all_scanned and current_state != STATE_CHEMICAL_ISSUED:
        existing_se = _find_submitted_manufacture_se(wo.name)
        if existing_se:
            response["manufacture_se"] = existing_se
        if wo.get("custom_spray_application_logsheet"):
            response["sal"] = wo.custom_spray_application_logsheet

    return response


def _transferred_into_csu(wo_name: str, wip: str) -> dict[str, float]:
    """item_code -> qty actually transferred into the CSU for THIS Work Order
    (from its submitted Material Transfer for Manufacture entries)."""
    out: dict[str, float] = {}
    rows = frappe.db.sql(
        """SELECT sed.item_code AS item, SUM(sed.qty) AS qty
           FROM `tabStock Entry Detail` sed
           JOIN `tabStock Entry` se ON se.name = sed.parent
           WHERE se.work_order = %s
             AND se.purpose = 'Material Transfer for Manufacture'
             AND se.docstatus = 1 AND sed.t_warehouse = %s
           GROUP BY sed.item_code""",
        (wo_name, wip),
        as_dict=True,
    )
    for r in rows:
        out[r.item] = flt(r.qty)
    return out


def _rebuild_manufacture_from_transfer(se_doc, wo_name: str, wip: str) -> None:
    """Floor-plan-is-truth: replace the BOM-backflushed raw consumption lines
    with the chemicals ACTUALLY transferred into the CSU for this WO.

    The reused template BOM frequently disagrees with the spray plan — it can
    demand chemicals that were never transferred (and only "succeed" because a
    shared CSU happens to hold them from other WOs), producing the wrong recipe
    and wrong quantities. The transfer == what was issued/scanned == the plan,
    so we consume exactly that. The finished-good line(s) are preserved; raises
    if the CSU received nothing for this WO.
    """
    tmap = _transferred_into_csu(wo_name, wip)
    if not tmap:
        frappe.throw(
            f"Cannot manufacture {wo_name}: no chemicals were transferred into "
            f"the CSU {wip!r}. Issue the chemicals first."
        )
    proto = None
    for r in (se_doc.items or []):
        if not r.get("is_finished_item"):
            proto = r
            break
    keep = [r for r in (se_doc.items or []) if r.get("is_finished_item")]
    se_doc.items = keep
    for ic in tmap:
        qty = flt(tmap[ic])
        if qty <= 0:
            continue
        suom = frappe.db.get_value("Item", ic, "stock_uom")
        val = flt(
            frappe.db.get_value(
                "Bin", {"item_code": ic, "warehouse": wip}, "valuation_rate"
            )
        )
        row = se_doc.append("items", {})
        row.item_code = ic
        row.qty = qty
        row.transfer_qty = qty
        row.s_warehouse = wip
        row.t_warehouse = None
        row.uom = suom
        row.stock_uom = suom
        row.conversion_factor = 1.0
        row.is_finished_item = 0
        row.allow_zero_valuation_rate = 1
        if val > 0:
            row.basic_rate = val
        if proto is not None and proto.get("expense_account"):
            row.expense_account = proto.expense_account
    idx = 1
    for r in se_doc.items:
        r.idx = idx
        idx = idx + 1


def _promote_to_tank_mix_manufactured(
    wo, csu_warehouse: str | None, posting_moment=None
):
    """Build Manufacture SE + SAL draft, flip WO to Tank Mix Manufactured.

    Caller must already hold the WO row lock and have verified all chemicals
    are scanned. Any throw here rolls back the whole register_csu_scan call.

    ``posting_moment`` back-dates the Manufacture to when the mix was actually made,
    for a session recorded offline and synced later. Without it the entry lands on
    the sync date and the cost misses the month the spray happened — the exact
    problem `redate_chain_to_transfer_console.py` was written to clean up.

    The caller is responsible for the moment being honest: it must not precede the
    transfer that put the raw chemicals in the CSU, or the ledger refuses it (see
    `offline_session.resolve_moments`, which clamps it).
    """
    from erpnext.manufacturing.doctype.work_order.work_order import (
        make_stock_entry as _make_se,
    )

    se_data = _make_se(work_order_id=wo.name, purpose="Manufacture")
    if not se_data:
        frappe.throw(
            f"Could not generate Manufacture Stock Entry for {wo.name}."
        )
    se_doc = frappe.get_doc(se_data) if isinstance(se_data, dict) else se_data
    se_doc.stock_entry_type = SE_TYPE_MIX
    if not getattr(se_doc, "to_warehouse", None):
        se_doc.to_warehouse = wo.fg_warehouse or wo.custom_greenhouse

    if posting_moment:
        moment = get_datetime(posting_moment)
        se_doc.set_posting_time = 1
        se_doc.posting_date = moment.date()
        se_doc.posting_time = moment.time()

    # Floor-plan-is-truth: rebuild the raw consumption from what was actually
    # transferred into the CSU for this WO, instead of the template BOM's
    # backflush (which can consume the wrong chemicals / quantities).
    wip = getattr(wo, "wip_warehouse", None)
    if not wip:
        frappe.throw(
            f"Cannot manufacture {wo.name}: no CSU (wip_warehouse) set."
        )
    _rebuild_manufacture_from_transfer(se_doc, wo.name, wip)

    # Stamp the greenhouse cost center on every SE row (raw consumption + FG)
    # so the per-chemical manufacture GL postings attribute to the greenhouse
    # rather than the company default (Main). Prefer the WO's derived cost
    # center; fall back to deriving it from the greenhouse warehouse.
    cost_center = getattr(wo, "custom_cost_center", None) or match_cost_center(
        wo.custom_greenhouse
    )
    if cost_center:
        for it in se_doc.items or []:
            it.cost_center = cost_center

    diff_account = frappe.db.get_single_value(
        "Scouting and Crop Protection Settings", "default_chemical_difference_account"
    )
    if diff_account and getattr(wo, "custom_type", None) == AFP_TYPE:
        se_doc.difference_account = diff_account

    se_doc.flags.ignore_permissions = True
    se_doc.flags.ignore_links = True
    se_doc.insert()
    _patch_zero_rates(se_doc)
    # Re-stamp: ERPNext's validate can reset item cost_center on insert.
    if cost_center:
        for it in se_doc.items or []:
            it.cost_center = cost_center
    se_doc.save(ignore_permissions=True)
    se_doc.submit()

    sal_name = _create_sal_draft(wo, se_doc)

    frappe.db.set_value(
        "Work Order",
        wo.name,
        {
            "workflow_state": STATE_TANK_MIX_MANUFACTURED,
            "custom_spray_application_logsheet": sal_name,
        },
        update_modified=True,
    )
    try:
        wo.add_comment(
            "Workflow",
            f"All chemicals scanned. Manufacture {se_doc.name} submitted and "
            f"draft Logsheet {sal_name} created. State: "
            f"{STATE_CHEMICAL_ISSUED} -> {STATE_TANK_MIX_MANUFACTURED}.",
        )
    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            "register_csu_scan: add_comment failed",
        )
    return se_doc.name, sal_name


# ──────────────────────────── manufacture_tank_mix ───────────────────────────


def build_manufacture_reconciliation(wo, manufacture_se) -> dict[str, Any]:
    """Per-chemical consumed/transferred/required + scanned, with match flags.

    Drives the mobile post-manufacture modal: did the quantities that went into
    the tank mix add up to what was transferred/required, and was every required
    chemical scanned? ``quantities_match`` is True only when, for every required
    item, consumed == transferred == required (tol 1e-6); ``all_scanned`` is True
    when every required chemical has a scan row.
    """
    consumed: dict[str, float] = {}
    produced = 0.0
    for it in (manufacture_se.items or []):
        if it.s_warehouse and not it.t_warehouse:
            consumed[it.item_code] = consumed.get(it.item_code, 0.0) + flt(it.qty)
        if it.t_warehouse and not it.s_warehouse:
            produced += flt(it.qty)
    scanned_codes = _scanned_codes(wo)
    chemicals = []
    quantities_match = True
    for r in (wo.required_items or []):
        c, t, rq = flt(consumed.get(r.item_code, 0.0)), flt(r.transferred_qty), flt(r.required_qty)
        if abs(c - t) > 1e-6 or abs(c - rq) > 1e-6:
            quantities_match = False
        chemicals.append({
            "item_code": r.item_code, "item_name": r.item_name,
            "consumed": c, "transferred": t, "required": rq,
            "scanned": r.item_code in scanned_codes,
        })
    return {
        "manufactured": True,
        "produced_qty": produced,
        "chemicals": chemicals,
        "all_scanned": _required_chemical_codes(wo).issubset(scanned_codes),
        "quantities_match": quantities_match,
    }


@frappe.whitelist()
def get_manufacture_reconciliation(work_order: str) -> dict[str, Any]:
    """Reconciliation block for a WO's tank-mix manufacture (modal data).

    Same shape as the ``reconciliation`` key in ``manufacture_tank_mix``'s
    response, but callable any time (e.g. when the app re-opens the screen).
    Returns ``manufactured: False`` with progress rows if no Manufacture SE yet.
    """
    if not work_order:
        frappe.throw("work_order is required.")
    wo = frappe.get_doc("Work Order", work_order)
    _ensure_afp(wo)
    se_name = _find_submitted_manufacture_se(wo.name)
    if se_name:
        return build_manufacture_reconciliation(wo, frappe.get_doc("Stock Entry", se_name))
    scanned_codes = _scanned_codes(wo)
    return {
        "manufactured": False,
        "produced_qty": 0.0,
        "chemicals": [{
            "item_code": r.item_code, "item_name": r.item_name,
            "consumed": 0.0, "transferred": flt(r.transferred_qty),
            "required": flt(r.required_qty), "scanned": r.item_code in scanned_codes,
        } for r in (wo.required_items or [])],
        "all_scanned": _required_chemical_codes(wo).issubset(scanned_codes),
        "quantities_match": False,
    }


@frappe.whitelist()
def manufacture_tank_mix(work_order: str, posting_moment=None) -> dict[str, Any]:
    """Explicitly manufacture the tank mix for a fully-scanned WO.

    ``posting_moment`` back-dates the Manufacture to when the mix was actually made, for a
    session recorded offline and synced later. It must not precede the transfer that put
    the raw chemicals in the CSU — `offline_session.resolve_moments` clamps it, and the
    ledger refuses it if anything slips through.

    This is the deliberate replacement for the old auto-promote-on-last-scan:
    the supervisor confirms the spray team and then presses "Confirm Tank Mix",
    which calls this. Decoupling manufacture from scanning gives exactly one
    trigger.

    Idempotent and double-manufacture-safe: the WO row is locked, and if a
    Manufacture SE already exists (or the WO is already past Chemical Issued)
    we converge to the existing one instead of creating a second.
    """
    if not work_order:
        frappe.throw("work_order is required.")

    current_state = _lock_wo(work_order)
    wo = frappe.get_doc("Work Order", work_order)
    _ensure_afp(wo)

    # Already manufactured (or beyond) — return the existing SE/SAL, no-op.
    if current_state in (
        STATE_TANK_MIX_MANUFACTURED,
        STATE_SPRAYING_IN_PROGRESS,
        STATE_COMPLETED,
    ):
        manu = _find_submitted_manufacture_se(wo.name)
        return {
            "workflow_state": current_state,
            "manufacture_se": manu,
            "sal": wo.get("custom_spray_application_logsheet"),
            "already": True,
            "reconciliation": (
                build_manufacture_reconciliation(wo, frappe.get_doc("Stock Entry", manu))
                if manu else None
            ),
        }

    if current_state != STATE_CHEMICAL_ISSUED:
        frappe.throw(
            f"Cannot manufacture tank mix: Work Order is in {current_state!r}, "
            f"expected {STATE_CHEMICAL_ISSUED!r}."
        )

    required = _required_chemical_codes(wo)
    scanned = _scanned_codes(wo)
    if not required or not required.issubset(scanned):
        missing = sorted(required - scanned)
        frappe.throw(
            "Cannot manufacture tank mix: not all chemicals have been scanned."
            + (f" Missing: {', '.join(missing)}." if missing else "")
        )

    # Defensive double-manufacture guard: if a submitted Manufacture SE somehow
    # already exists while state is still Chemical Issued, converge to it rather
    # than creating a second one.
    existing_se = _find_submitted_manufacture_se(wo.name)
    if existing_se:
        frappe.db.set_value(
            "Work Order", wo.name, "workflow_state",
            STATE_TANK_MIX_MANUFACTURED, update_modified=True,
        )
        return {
            "workflow_state": STATE_TANK_MIX_MANUFACTURED,
            "manufacture_se": existing_se,
            "sal": wo.get("custom_spray_application_logsheet"),
            "already": True,
            "reconciliation": build_manufacture_reconciliation(
                wo, frappe.get_doc("Stock Entry", existing_se)
            ),
        }

    manu_se_name, sal_name = _promote_to_tank_mix_manufactured(
        wo, None, posting_moment=posting_moment
    )
    wo = frappe.get_doc("Work Order", work_order)   # reload post-manufacture
    return {
        "workflow_state": STATE_TANK_MIX_MANUFACTURED,
        "manufacture_se": manu_se_name,
        "sal": sal_name,
        "reconciliation": build_manufacture_reconciliation(
            wo, frappe.get_doc("Stock Entry", manu_se_name)
        ),
    }


# ───────────────────────────── SAL draft builder ─────────────────────────────


def _sal_farm_for(wo) -> str:
    """Resolve the Farm name for the SAL. Warehouse.custom_farm wins; we
    fall back to _derive_farm so non-canonical greenhouse names still resolve."""
    if wo.custom_greenhouse:
        farm = frappe.db.get_value("Warehouse", wo.custom_greenhouse, "custom_farm")
        if farm:
            return farm
    derived = _derive_farm(wo.custom_greenhouse)
    if derived:
        return derived
    frappe.throw(
        f"Cannot derive Farm for SAL: Work Order {wo.name} has greenhouse "
        f"{wo.custom_greenhouse!r} with no custom_farm set."
    )


def _sal_first_target_pest(wo) -> str | None:
    """Parse wo.custom_targets (Code field, JSON) and return the first entry
    that names a known Pest. Returns None if nothing matches."""
    raw = (getattr(wo, "custom_targets", None) or "").strip()
    if not raw:
        return None
    try:
        targets = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(targets, list):
        return None
    for entry in targets:
        name = None
        if isinstance(entry, str):
            name = entry.strip()
        elif isinstance(entry, dict):
            name = (entry.get("name") or entry.get("pest") or entry.get("label") or "").strip()
        if name and frappe.db.exists("Pest", name):
            return name
    return None


_SPRAY_TYPE_MAP = {
    "full spray": "Full Spray",
    "full": "Full Spray",
    "spot spray": "Spot Spray",
    "spot": "Spot Spray",
}


def _map_spray_type(value: str | None) -> str | None:
    if not value:
        return None
    return _SPRAY_TYPE_MAP.get(str(value).strip().lower())


def _create_sal_draft(wo, manufacture_se) -> str:
    """Insert a draft Spray Application Logsheet per the Part B field map.

    Returns the new SAL's name. The SAL is left at docstatus=0; supervisor
    fills in remaining fields (weather edits, applicators) and end_spray_session
    submits it.
    """
    scans = list(wo.custom_chemical_scans or [])
    sal_payload: dict[str, Any] = {
        "doctype": "Spray Application Logsheet",
        "work_order": wo.name,
        "date": (
            wo.custom_scheduled_application_time.date().isoformat()
            if getattr(wo, "custom_scheduled_application_time", None)
            else today()
        ),
        "farm": _sal_farm_for(wo),
        "crop": wo.custom_variety or wo.production_item,
        # ``weather`` is reqd on the SAL doctype but the supervisor edits it
        # at end-spray. Default to "Cool" so the draft inserts cleanly.
        "weather": "Cool",
        "mixing_start_time": scans[0].scanned_at.time() if scans else None,
        "mixing_stop_time": scans[-1].scanned_at.time() if scans else None,
        "target_gh": wo.custom_greenhouse,
        "target_area_ha": flt(wo.custom_area) if wo.custom_area else None,
        "variety": wo.custom_variety,
        "target_pests": _sal_first_target_pest(wo),
        "spray_type": _map_spray_type(wo.custom_spray_type),
        "method_of_application": "CSU",
        "re_entry_interval_hrs": flt(wo.custom_reentry_period_hrs) if wo.custom_reentry_period_hrs else None,
        "pesticides": [],
    }

    # Mixing persons: distinct scanned_by employees in scan order, first two.
    seen: set[str] = set()
    mixers: list[str] = []
    for s in scans:
        if s.scanned_by and s.scanned_by not in seen:
            seen.add(s.scanned_by)
            mixers.append(s.scanned_by)
        if len(mixers) >= 2:
            break
    if mixers:
        sal_payload["persons_mixing_1"] = mixers[0]
    if len(mixers) >= 2:
        sal_payload["persons_mixing_2"] = mixers[1]

    for r in wo.required_items or []:
        sal_payload["pesticides"].append(
            {
                "pesticide_name": r.item_name or r.item_code,
                "rate": (
                    str(absolute_to_rate(r.required_qty, wo.custom_water_volume))
                    if r.required_qty else None
                ),
                "pesticide_quantity": flt(r.required_qty) if r.required_qty else None,
            }
        )

    sal = frappe.get_doc(sal_payload)
    sal.flags.ignore_permissions = True
    sal.insert()
    return sal.name


# ──────────────────────────── start_spray_session ────────────────────────────


@frappe.whitelist()
def start_spray_session(
    work_order: str,
    started_at=None,
    enforce_cutoff: bool = True,
    employee: str | None = None,
) -> dict[str, Any]:
    """Open a Sprayer Movement Session for an Application Floor Plan WO.

    Preconditions: WO state == Tank Mix Manufactured, SAL linked. Side effects:
    creates an Active Sprayer Movement Session, stamps the SAL's
    application_start_time + start_time, advances the WO to Spraying In
    Progress and writes actual_start_date.

    ``started_at`` is when the spray actually began, for a session recorded offline and
    synced later. Without it the stamp is the moment of sync, so a spray done at 06:00
    and synced at noon reads as a noon spray — and the SAL's `Time` fields carry no date
    to contradict it. Defaults to now, which is the online case.

    ``enforce_cutoff=False`` is for replaying a session that already happened. The daily
    cutoff exists to stop somebody *deciding to start* a spray too late in the day;
    refusing to *record* a spray that was carried out hours ago is a different act, and
    doing so would lose the only account of real work. The offline sync passes False and
    flags the session `past_cutoff` instead, so a late spray is visible rather than
    discarded.
    """
    if not work_order:
        frappe.throw("work_order is required.")

    current_state = _lock_wo(work_order)
    wo = frappe.get_doc("Work Order", work_order)
    _ensure_afp(wo)

    if current_state != STATE_TANK_MIX_MANUFACTURED:
        frappe.throw(
            f"Cannot start spray: Work Order is in {current_state!r}, expected "
            f"{STATE_TANK_MIX_MANUFACTURED!r}."
        )

    # The daily cutoff. A plan whose deadline has passed is not sprayed late — it is
    # postponed to a date somebody agreed to, which is the whole point of having a
    # cutoff. Checked here rather than in the client because the client is what would
    # be bypassed.
    #
    # Skipped when replaying a recorded session: see `enforce_cutoff` above. The spray has
    # already happened, and a rule about when work may START cannot sensibly forbid writing
    # down that it did.
    if enforce_cutoff:
        from upande_scp.serverscripts.spray_plan_creator import postponement

        postponement.assert_within_cutoff(work_order)

    sal_name = wo.custom_spray_application_logsheet
    if not sal_name:
        frappe.throw(
            f"Cannot start spray: Work Order {wo.name} has no Spray Application "
            "Logsheet linked. Re-run the chemical-scan flow."
        )

    # `employee` names who actually sprayed, for a replayed session. Falling back to the
    # session user would credit the spray to whoever pressed Sync.
    employee = _resolve_employee_from_session(employee)
    now = get_datetime(started_at) if started_at else now_datetime()

    sms = frappe.get_doc(
        {
            "doctype": "Sprayer Movement Session",
            "work_order": wo.name,
            "employee": employee,
            "greenhouse": wo.custom_greenhouse,
            "status": "Active",
            "started_at": now,
        }
    )
    sms.flags.ignore_permissions = True
    sms.insert()

    frappe.db.set_value(
        "Spray Application Logsheet",
        sal_name,
        {
            "application_start_time": now.time(),
            "start_time": now.time(),
        },
        update_modified=True,
    )

    frappe.db.set_value(
        "Work Order",
        wo.name,
        {
            "workflow_state": STATE_SPRAYING_IN_PROGRESS,
            "actual_start_date": now,
        },
        update_modified=True,
    )
    try:
        wo.add_comment(
            "Workflow",
            f"Spray session started by {frappe.session.user}. SMS {sms.name}. "
            f"State: {STATE_TANK_MIX_MANUFACTURED} -> {STATE_SPRAYING_IN_PROGRESS}.",
        )
    except Exception:
        frappe.log_error(
            frappe.get_traceback(), "start_spray_session: add_comment failed"
        )

    return {
        "workflow_state": STATE_SPRAYING_IN_PROGRESS,
        "sprayer_movement_session": sms.name,
        "sal": sal_name,
        "started_at": now.isoformat(),
    }


# ───────────────────────────── end_spray_session ─────────────────────────────


def _find_submitted_manufacture_se(wo_name: str) -> str | None:
    """Return the most-recent submitted Manufacture SE for this WO, or None."""
    rows = frappe.get_all(
        "Stock Entry",
        filters={
            "work_order": wo_name,
            "purpose": "Manufacture",
            "docstatus": 1,
        },
        fields=["name"],
        order_by="creation DESC",
        limit=1,
    )
    return rows[0].name if rows else None


def _open_sms_for(wo_name: str) -> str | None:
    rows = frappe.get_all(
        "Sprayer Movement Session",
        filters={"work_order": wo_name, "status": "Active"},
        fields=["name"],
        order_by="started_at DESC",
        limit=1,
    )
    return rows[0].name if rows else None


def _team_applicators(wo) -> list[dict[str, Any]]:
    """Build SAL applicator rows from wo.custom_spray_plan_team_members.

    All non-supervisor team members with an Employee link are included.
    """
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in wo.custom_spray_plan_team_members or []:
        emp = getattr(row, "employee", None)
        if not emp or emp in seen:
            continue
        role = (getattr(row, "role", "") or "").strip().lower()
        if role == "supervisor":
            continue
        seen.add(emp)
        out.append({"applicator_name": emp})
    return out


@frappe.whitelist()
def update_work_order_team(work_order: str = None, team=None) -> dict[str, Any]:
    """Record who is spraying, just before the spray starts.

    Reached at the bare path ``/api/method/update_work_order_team``, which had no
    implementation anywhere — the handset called it, got a 404, and
    ``api.ts`` turned that into ``{success: true, simulated: true}``. So
    ``plan-details.tsx``'s ``if (teamRes?.success === false) throw`` never fired and the
    team the supervisor had just confirmed on screen was silently discarded, leaving the
    SAL applicators to be built from whatever the planner set days earlier.

    Writing the child table matters beyond the audit trail: ``_team_applicators`` reads
    ``custom_spray_plan_team_members`` to build the logsheet's applicator rows, so the
    people named here are the people recorded as exposed to the chemical.

    The WO is submitted, so the rows are replaced directly rather than through
    ``wo.save()`` — a full save re-runs ERPNext's manufacturing validations, which is the
    wrong tool for what is an audit-log write. Same reasoning as ``register_csu_scan``.
    """
    work_order = work_order or frappe.form_dict.get("work_order_name")
    if not work_order:
        frappe.throw("work_order_name is required.")

    if team is None:
        team = frappe.form_dict.get("team")
    if isinstance(team, str):
        team = json.loads(team or "[]")
    if not isinstance(team, list):
        frappe.throw("team must be a list of members.")

    if not frappe.db.exists("Work Order", work_order):
        frappe.throw(f"{work_order} does not exist.")

    # `id` is the Employee, `name` its display name — the shape `plan-details.tsx`
    # builds from `custom_spray_plan_team_members` and hands straight back.
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for member in team:
        if not isinstance(member, dict):
            continue
        employee = str(member.get("id") or member.get("employee") or "").strip()
        if not employee or employee in seen:
            continue
        seen.add(employee)
        rows.append({
            "employee": employee,
            "employee_name": str(
                member.get("name") or member.get("employee_name") or ""
            ).strip(),
            "role": str(member.get("role") or "").strip(),
        })

    # An empty team is refused rather than written: it is far more likely to be a
    # screen that lost its state than a deliberate act, and overwriting a real team
    # with nothing costs the logsheet its applicators.
    if not rows:
        frappe.throw("A spray team needs at least one member with an employee.")

    frappe.db.delete(
        "Custom Spray Plan Team Member",
        {
            "parent": work_order,
            "parenttype": "Work Order",
            "parentfield": "custom_spray_plan_team_members",
        },
    )
    for idx, row in enumerate(rows, start=1):
        child = frappe.get_doc({
            "doctype": "Custom Spray Plan Team Member",
            "parent": work_order,
            "parenttype": "Work Order",
            "parentfield": "custom_spray_plan_team_members",
            "idx": idx,
            **row,
        })
        child.flags.ignore_permissions = True
        child.insert()

    # `custom_spray_team` is the human-readable copy the desk form and the plan list
    # show. Kept in step so the two never disagree about who sprayed.
    frappe.db.set_value(
        "Work Order",
        work_order,
        "custom_spray_team",
        "\n".join(
            f"{r['employee_name'] or r['employee']} - {r['role']}".rstrip(" -")
            for r in rows
        ),
        update_modified=False,
    )

    return {"success": True, "work_order": work_order, "members": len(rows)}


@frappe.whitelist()
def end_spray_session(work_order: str, ended_at=None) -> dict[str, Any]:
    """Close out a spray: fire Material Issue, submit SAL, close SMS, mark WO Completed.

    ``ended_at`` is when the spray actually finished, for an offline session. It dates the
    SAL close, the session close, the WO's actual_end_date **and the Material Issue** —
    which is the one that matters for costing, since that is what debits the greenhouse.

    Preconditions: WO state == Spraying In Progress, Manufacture SE on file,
    SAL drafted. Side effects:
      * Fills SAL end-times + supervisor + applicators, then submits it.
      * Calls ``build_and_submit_material_issue`` so the greenhouse is debited.
      * Closes the open Sprayer Movement Session.
      * Flips the WO to Completed and writes actual_end_date.

    Any throw rolls back the whole transaction — including the (potentially
    half-built) Material Issue.
    """
    if not work_order:
        frappe.throw("work_order is required.")

    current_state = _lock_wo(work_order)
    wo = frappe.get_doc("Work Order", work_order)
    _ensure_afp(wo)

    # Idempotent: a double-tap / retry on an already-finished plan returns
    # success instead of throwing, so the app's Stop "just works".
    if current_state == STATE_COMPLETED:
        return {
            "workflow_state": STATE_COMPLETED,
            "sal_submitted": wo.custom_spray_application_logsheet,
            "already": True,
        }

    if current_state != STATE_SPRAYING_IN_PROGRESS:
        frappe.throw(
            f"Cannot end spray: Work Order is in {current_state!r}, expected "
            f"{STATE_SPRAYING_IN_PROGRESS!r}."
        )

    sal_name = wo.custom_spray_application_logsheet
    if not sal_name:
        frappe.throw(
            f"Cannot end spray: Work Order {wo.name} has no Spray Application "
            "Logsheet linked."
        )
    sal = frappe.get_doc("Spray Application Logsheet", sal_name)
    if sal.docstatus != 0:
        frappe.throw(
            f"Spray Application Logsheet {sal_name} is already in docstatus="
            f"{sal.docstatus}; cannot finalise."
        )

    manu_name = _find_submitted_manufacture_se(wo.name)
    if not manu_name:
        frappe.throw(
            f"Cannot end spray: no submitted Manufacture Stock Entry found for "
            f"Work Order {wo.name}."
        )
    manu_se = frappe.get_doc("Stock Entry", manu_name)
    # Resolve the supervisor from the WO's spray team (not the session user) so
    # Stop never throws just because the person pressing it has no linked
    # Employee — the same robust resolution the Material Issue already uses.
    supervisor_emp = resolve_supervisor_employee(wo)
    now = get_datetime(ended_at) if ended_at else now_datetime()

    # Fill SAL closing fields, then submit. The `Time` fields carry no date, so the
    # datetime pair below is written alongside them — a session that crossed midnight, or
    # was synced the next morning, cannot be reconstructed from a bare time.
    sal.application_stop_time = now.time()
    sal.end_time = now.time()
    if sal.meta.get_field("custom_application_stop_at"):
        sal.custom_application_stop_at = now
    sal.supervisor_name = supervisor_emp
    sal.applicators = []
    for app in _team_applicators(wo):
        sal.append("applicators", app)
    sal.flags.ignore_permissions = True
    sal.save()
    sal.submit()

    # Fire the Material Issue. Any throw here rolls back the SAL submit + all
    # downstream state. ``build_and_submit_material_issue`` rebuilds the issue
    # payload from the Manufacture SE, so we don't need to track FG rows here.
    # Dated to when the spray finished, not when it synced: this is the entry that
    # debits the greenhouse, so it decides which month carries the cost.
    mi_name = build_and_submit_material_issue(wo, manu_se, posting_moment=now)

    # Close the SMS (best-effort discovery — there should be exactly one open
    # session for this WO).
    sms_name = _open_sms_for(wo.name)
    if sms_name:
        frappe.db.set_value(
            "Sprayer Movement Session",
            sms_name,
            {"status": "Completed", "ended_at": now},
            update_modified=True,
        )

    frappe.db.set_value(
        "Work Order",
        wo.name,
        {
            "workflow_state": STATE_COMPLETED,
            "actual_end_date": now,
        },
        update_modified=True,
    )
    try:
        wo.add_comment(
            "Workflow",
            f"Spray session ended by {frappe.session.user}. Material Issue "
            f"{mi_name} submitted, SAL {sal_name} submitted. State: "
            f"{STATE_SPRAYING_IN_PROGRESS} -> {STATE_COMPLETED}.",
        )
    except Exception:
        frappe.log_error(
            frappe.get_traceback(), "end_spray_session: add_comment failed"
        )

    return {
        "workflow_state": STATE_COMPLETED,
        "material_issue": mi_name,
        "sal_submitted": sal_name,
        "sprayer_movement_session": sms_name,
        "ended_at": now.isoformat(),
    }
