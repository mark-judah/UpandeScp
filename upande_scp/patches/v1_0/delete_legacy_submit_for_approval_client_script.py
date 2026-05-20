"""Delete the legacy 'Submit button  Work order' Client Script.

Historical DB-only Client Script (created via the Desk, never tracked
in fixtures) that added a 'Submit for Approval' button calling
``frappe.model.workflow.apply_workflow`` directly. With the
Application Floor Plan Workflow removed (see
``delete_application_floor_plan_workflow``), that call raises
``DoesNotExistError: Workflow Application Floor Plan Workflow not
found``. The working 'Submit for Approval' button (via
``public/js/spray_plan_wo_form.js`` → ``bulk.submit_drafts_for_approval``)
is the only one we want loaded on the form now.

Idempotent — no-op if the record never existed on this site.
"""
from __future__ import annotations

import frappe


def execute() -> None:
    name = "Submit button  Work order"  # double space intentional — matches DB
    if not frappe.db.exists("Client Script", name):
        return
    frappe.delete_doc("Client Script", name, force=True, ignore_missing=True)
    frappe.db.commit()
