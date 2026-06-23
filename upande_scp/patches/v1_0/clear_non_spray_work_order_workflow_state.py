"""Clear workflow_state on Work Orders that aren't Application Floor Plans.

The Application Floor Plan Workflow is bound to the Work Order DocType,
so before the ``work_order_workflow_gate`` hook existed every Work Order
picked up a workflow_state. This one-off patch clears the leftover state
on every non-spray Work Order so the workflow stops applying to them.

Raw SQL avoids bumping ``modified`` / ``modified_by`` on every historical
record. Idempotent.
"""
from __future__ import annotations

import frappe


def execute() -> None:
    if not frappe.db.has_column("Work Order", "custom_type"):
        return
    if not frappe.db.has_column("Work Order", "workflow_state"):
        return
    frappe.db.sql(
        """
        UPDATE `tabWork Order`
        SET workflow_state = NULL
        WHERE COALESCE(custom_type, '') != 'Application Floor Plan'
          AND workflow_state IS NOT NULL
        """
    )
    frappe.db.commit()
