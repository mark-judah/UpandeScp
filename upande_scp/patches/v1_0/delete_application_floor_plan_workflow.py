"""Delete the Application Floor Plan Workflow record.

The workflow was bound to the Work Order DocType, which made Frappe's
workflow framework (default-state setter, allow_edit gate, form
States class, get_transitions endpoint, client-side is_read_only)
run on every Work Order — including unrelated manufacturing orders.
The user-visible spray-plan state machine is implemented entirely in
custom code (``serverscripts/spray_plan_creator/bulk.py``,
``serverscripts/spray_plan_approval.py``,
``serverscripts/spray_plan_creator/auto_material_issue.py``,
``public/js/spray_plan_wo_form.js``) which drives the
``workflow_state`` field directly, so removing the Frappe Workflow
record has no effect on the spray-plan UX.

The ``workflow_state`` Custom Field on Work Order and the
``tabWorkflow State`` records (Pending Submission, Awaiting Approval,
…) are intentionally left in place — they carry the historical values
and are used by the custom endpoints.

Idempotent.
"""
from __future__ import annotations

import frappe


def execute() -> None:
    name = "Application Floor Plan Workflow"
    if not frappe.db.exists("Workflow", name):
        return
    frappe.delete_doc("Workflow", name, force=True, ignore_missing=True)
    frappe.db.commit()
    # The DocType meta caches the workflow association; without an explicit
    # invalidation the next save raises "Workflow ... not found".
    frappe.clear_cache(doctype="Work Order")
