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

AFP_TYPE = "Application Floor Plan"
CHEMICAL_ISSUED = "Chemical Issued"


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
