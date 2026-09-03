"""Stock Entry hooks for the Application Floor Plan spray flow.

Two hooks are wired in hooks.py, both dispatching on ``purpose`` and both acting
only when the related Work Order is an AFP.

``before_validate`` corrects the entry before ERPNext validates it: a transfer
gets the plan's cost centre stamped on every row, a Manufacture gets its
consumption rebuilt from what actually reached the CSU. See the function.

``on_submit`` moves the plan's state. We dispatch on
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
from frappe.utils import cint, flt

AFP_TYPE = "Application Floor Plan"
CHEMICAL_ISSUED = "Chemical Issued"
TRANSFER_PURPOSE = "Material Transfer for Manufacture"
SETTINGS = "Scouting and Crop Protection Settings"


def _afp_cost_center(wo_name):
    """The cost centre this plan belongs to, or None.

    `custom_cost_center` is what the plan itself resolved at creation
    (drafts._resolve_cost_center_with_override: the operator's override, else
    the greenhouse chain). Older plans predate that field, so the greenhouse is
    resolved again as a fallback.
    """
    from upande_scp.serverscripts.spray_plan_creator.validation import (
        match_cost_center,
    )

    cc = frappe.db.get_value("Work Order", wo_name, "custom_cost_center")
    if cc:
        return cc
    return match_cost_center(
        frappe.db.get_value("Work Order", wo_name, "custom_greenhouse")
    )


def _stamp_rows(doc, cc):
    """Attribute every line to `cc` so the GL splits by greenhouse."""
    if not cc:
        return
    for it in (doc.items or []):
        it.cost_center = cc


def _transfer_stamp_enabled():
    """Whether CSU transfers get the greenhouse cost centre.

    Plainly the stored value — `get_single_value` casts a missing Check to 0, so
    there is no telling an absent row from a deliberate OFF here. The ON default
    is written down once by the `stamp_transfer_cost_center_on` patch instead.
    Turning it off hands the transfer back to ERPNext's own chain (Item Default
    buying cost centre, then the Company default).
    """
    return bool(cint(frappe.db.get_single_value(SETTINGS, "stamp_transfer_cost_center")))


def before_validate(doc, method):
    """Correct AFP stock entries before ERPNext validates them.

    Two jobs, dispatched on `purpose`:

      * `Material Transfer for Manufacture` — stamp the plan's cost centre on
        every row. ERPNext builds this entry itself (work_order.make_stock_entry,
        called from spray_plan_approval.approve_single_work_order) and knows
        nothing about `custom_cost_center`, so without this the rows fall back to
        the Item Default buying cost centre and then the Company default. When
        both are blank the entry is refused outright with "Cost Center is
        mandatory for Item ...". Mixing and Spray have always stamped it; the
        transfer was the one that did not.

      * `Manufacture` — the consumption rebuild below.
    """
    if getattr(doc, "purpose", None) == TRANSFER_PURPOSE:
        wo_name = getattr(doc, "work_order", None)
        if (
            wo_name
            and frappe.db.get_value("Work Order", wo_name, "custom_type") == AFP_TYPE
            and _transfer_stamp_enabled()
        ):
            _stamp_rows(doc, _afp_cost_center(wo_name))
        return None

    return _before_validate_manufacture(doc)


def _before_validate_manufacture(doc):
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
    _stamp_rows(doc, _afp_cost_center(wo_name))

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

    wo_type = frappe.db.get_value("Work Order", work_order_name, "custom_type")
    if wo_type != AFP_TYPE:
        return None

    # Issue the traceable label codes here — the transfer has just been submitted, so
    # the quantity on each line is what physically moved and the code can carry it as
    # fact. Generating at approval time (which is what approve_and_forward used to do)
    # put a *proposed* quantity on the sticker, since the draft stays editable until
    # the storesman submits it.
    #
    # Deliberately AFTER the Application Floor Plan check. "Material Transfer for
    # Manufacture" is ERPNext's ordinary transfer-to-WIP purpose, used by every
    # manufacturing flow on the site — so gating on purpose alone minted chemical
    # QR labels for every unrelated work order's transfer. Labels belong to spray
    # plans only.
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
