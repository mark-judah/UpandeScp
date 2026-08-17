"""Stock Entry on_submit dispatcher for the Application Floor Plan spray flow.

The hook is wired in hooks.py against ``Stock Entry.on_submit``. We dispatch on
``purpose`` and only act when the related Work Order is an AFP. State
transitions:

  * ``Material Transfer for Manufacture`` -> WO state ``Chemical Issued``
    (storekeeper submitted the issue from the chemical store to the CSU).
  * ``Manufacture``                      -> no-op. ``register_csu_scan`` is the
    authoritative writer for ``Tank Mix Manufactured``.
  * ``Material Issue``                   -> no-op. ``end_spray_session`` is the
    authoritative writer for ``Completed``.
  * anything else                        -> no-op.

Throws here propagate out of ``doc.submit()`` and Frappe rolls back the whole
transaction, including the Stock Entry's docstatus=1 write.
"""
from __future__ import annotations

import frappe
from frappe.utils import flt

AFP_TYPE = "Application Floor Plan"
CHEMICAL_ISSUED = "Chemical Issued"


def before_validate(doc, method):
    """Auto-correct EVERY AFP Manufacture to consume what was transferred.

    Wired on ``Stock Entry.before_validate`` so it runs before ERPNext's own
    validate (stock / valuation / FG) — those checks then apply to the
    corrected lines. This is the safety net that makes the floor-plan-is-truth
    invariant hold no matter how the Manufacture is created: the mobile flow,
    the API, a console script, or the ERPNext desk ("Finish"/Make Stock Entry).
    Without it, a desk-made Manufacture would backflush the reused template
    BOM's recipe and consume the WRONG chemicals off the shared CSU.

    The raw consumption is rebuilt from the WO's submitted Material Transfer
    into the CSU (consume == transferred == plan); the finished-good line is
    preserved. If the consumption was actually changed, a visible note is
    raised so the operator/auditor knows it was adjusted.
    """
    if getattr(doc, "purpose", None) != "Manufacture":
        return None
    wo_name = getattr(doc, "work_order", None)
    if not wo_name:
        return None
    if frappe.db.get_value("Work Order", wo_name, "custom_type") != AFP_TYPE:
        return None
    wip = frappe.db.get_value("Work Order", wo_name, "wip_warehouse")
    if not wip:
        return None

    # Reuse the rebuild already used by the manufacture endpoint (single source
    # of the floor-plan-is-truth logic). Lazy import avoids any load-order cost.
    from upande_scp.serverscripts.spray_plan_creator.spray_session import (
        _rebuild_manufacture_from_transfer,
    )
    from upande_scp.serverscripts.spray_plan_creator.validation import (
        match_cost_center,
    )

    def raw_totals(d):
        out: dict[str, float] = {}
        for r in (d.items or []):
            if not r.get("is_finished_item") and r.item_code:
                out[r.item_code] = flt(out.get(r.item_code, 0.0)) + flt(r.qty)
        return out

    before = raw_totals(doc)
    _rebuild_manufacture_from_transfer(doc, wo_name, wip)

    # Stamp the greenhouse cost center on every row so the per-chemical GL
    # attributes to the greenhouse, not the company default.
    cc = frappe.db.get_value("Work Order", wo_name, "custom_cost_center")
    if not cc:
        cc = match_cost_center(
            frappe.db.get_value("Work Order", wo_name, "custom_greenhouse")
        )
    if cc:
        for it in (doc.items or []):
            it.cost_center = cc

    after = raw_totals(doc)
    if before != after:
        frappe.msgprint(
            "Manufacture consumption was auto-corrected to match the chemicals "
            "transferred into the CSU for this work order (floor-plan-is-truth). "
            "BOM-backflushed lines were replaced.",
            title="Tank mix recipe corrected",
            indicator="orange",
        )
    return None


def on_submit(doc, method):
    purpose = getattr(doc, "purpose", None)
    if purpose != "Material Transfer for Manufacture":
        return None

    work_order_name = getattr(doc, "work_order", None)
    if not work_order_name:
        return None

    # Issue the traceable label codes here — the transfer has just been submitted, so
    # the quantity on each line is what physically moved and the code can carry it as
    # fact. Generating at approval time (which is what approve_and_forward used to do)
    # put a *proposed* quantity on the sticker, since the draft stays editable until
    # the storesman submits it.
    #
    # Best-effort: a label problem must never roll back a stock movement that has
    # already happened.
    try:
        from upande_scp.serverscripts.qr.chemical_labels import issue_for_stock_entry

        issue_for_stock_entry(doc)
    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            f"Chemical QR – issue on submit: {doc.name}",
        )

    wo_type = frappe.db.get_value("Work Order", work_order_name, "custom_type")
    if wo_type != AFP_TYPE:
        return None

    current_state = frappe.db.get_value(
        "Work Order", work_order_name, "workflow_state"
    )
    if current_state == CHEMICAL_ISSUED:
        return None

    frappe.db.set_value(
        "Work Order",
        work_order_name,
        "workflow_state",
        CHEMICAL_ISSUED,
        update_modified=True,
    )
    try:
        wo = frappe.get_doc("Work Order", work_order_name)
        wo.add_comment(
            "Workflow",
            f"Stock Entry {doc.name} (Material Transfer for Manufacture) "
            f"submitted by {frappe.session.user}. "
            f"State: {current_state or 'Approved'} -> {CHEMICAL_ISSUED}.",
        )
    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            "stock_entry_state.on_submit: add_comment failed",
        )
    return CHEMICAL_ISSUED
