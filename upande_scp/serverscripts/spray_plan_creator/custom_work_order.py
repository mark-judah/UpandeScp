# upande_scp/serverscripts/spray_plan_creator/custom_work_order.py
"""Restrict the Application Floor Plan Workflow to spray-plan Work Orders.

The workflow (see ``upande_scp/fixtures/workflow.json``) is bound to the
``Work Order`` DocType, but should only govern Work Orders where
``custom_type == "Application Floor Plan"``. Frappe binds a Workflow 1:1
to a DocType, so we override the controller's ``validate_workflow`` to
no-op for everything else. This bypasses the default-state setter, the
``allow_edit`` role gate, and the transition check inside
``frappe.model.workflow.validate_workflow`` — the workflow simply does
not exist for non-spray Work Orders.

Wired via ``override_doctype_class`` in hooks.py.
"""
from __future__ import annotations

from erpnext.manufacturing.doctype.work_order.work_order import WorkOrder


class CustomWorkOrder(WorkOrder):
    def validate_workflow(self):
        if (self.get("custom_type") or "") != "Application Floor Plan":
            self.workflow_state = None
            return
        return super().validate_workflow()
