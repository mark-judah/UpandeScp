"""Ensure the app-managed ``workflow_state`` Custom Field exists on Work Order.

The spray-plan state machine is driven entirely by custom code — there is no
Frappe Workflow on Work Order (``delete_application_floor_plan_workflow``
removes it), so the framework does NOT create ``workflow_state`` on this
DocType. The field is also intentionally kept out of the curated
``fixtures/custom_field.json`` allowlist, so fixtures don't create it either.

Net effect on any site without a (long-removed) Work Order workflow: the
column is absent, and every endpoint that filters Work Orders by
``workflow_state`` (``list_my_draft_plans``, ``spray_plan_approval``,
``spray_session``, the daily report, …) dies with
``Unknown column 'workflow_state' in 'WHERE'``.

This recreates the field — the exact definition that used to ship in
``fixtures/custom_field.json`` before it was dropped — whenever the column is
missing. Idempotent: guarded on ``has_column`` and ``create_custom_fields``
is itself a no-op for fields that already exist.
"""
from __future__ import annotations

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

# Leading blank = the unset/empty state, then the app's own states. Matches the
# historical fixture options string exactly.
WORKFLOW_STATE_OPTIONS = "\n".join(
    [
        "",
        "Pending Submission",
        "Awaiting Approval",
        "Approved",
        "Chemical Issued",
        "Tank Mix Manufactured",
        "Spraying In Progress",
        "Completed",
    ]
)


def execute() -> None:
    if frappe.db.has_column("Work Order", "workflow_state"):
        return
    create_custom_fields(
        {
            "Work Order": [
                {
                    "fieldname": "workflow_state",
                    "label": "Workflow State",
                    "fieldtype": "Select",
                    "options": WORKFLOW_STATE_OPTIONS,
                    "insert_after": "status",
                    "read_only": 1,
                    "translatable": 1,
                }
            ]
        },
        ignore_validate=True,
    )
    frappe.db.commit()
