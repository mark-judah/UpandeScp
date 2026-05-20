# upande_scp/serverscripts/spray_plan_creator/workflow_transitions.py
"""Override for ``frappe.model.workflow.get_transitions``.

The default endpoint throws "Workflow State not set" when a record's
``workflow_state`` is empty. Since the Application Floor Plan Workflow
is bound to ``Work Order`` but only governs spray-plan WOs (see
``CustomWorkOrder``), every non-spray Work Order has an empty state — and
the form's workflow widget calls this endpoint on refresh, surfacing the
error to the user.

This wrapper short-circuits to ``[]`` for non-spray Work Orders and
delegates everything else to the original.
"""
from __future__ import annotations

import frappe
from frappe.model.workflow import get_transitions as _orig_get_transitions


@frappe.whitelist()
def get_transitions(doc, workflow=None, raise_exception=False):
    if hasattr(doc, "doctype"):
        doctype = doc.doctype
        custom_type = doc.get("custom_type") or ""
    else:
        d = frappe.parse_json(doc) if isinstance(doc, str) else doc
        doctype = d.get("doctype") if isinstance(d, dict) else None
        custom_type = (d.get("custom_type") or "") if isinstance(d, dict) else ""

    if doctype == "Work Order" and custom_type != "Application Floor Plan":
        return []
    return _orig_get_transitions(doc, workflow=workflow, raise_exception=raise_exception)
