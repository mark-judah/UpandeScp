"""Tests for the auto-Material-Issue hook on Manufacture Stock Entry submit."""
from __future__ import annotations

import frappe
from frappe.tests.utils import FrappeTestCase

from upande_scp.serverscripts.spray_plan_creator.auto_material_issue import (
    on_manufacture_submit,
)


class _FakeSE:
    """Minimal stand-in for a Stock Entry doc — only the fields the handler reads."""

    def __init__(self, purpose: str = "Manufacture", work_order: str | None = None):
        self.purpose = purpose
        self.work_order = work_order


class TestAutoMaterialIssueNoOp(FrappeTestCase):
    def test_non_manufacture_purpose_is_noop(self):
        """A Material Transfer SE must not trigger the auto-issue handler."""
        se = _FakeSE(purpose="Material Transfer", work_order="MFG-WO-FAKE")
        # Should return None and raise nothing.
        self.assertIsNone(on_manufacture_submit(se, method="on_submit"))

    def test_manufacture_without_work_order_is_noop(self):
        se = _FakeSE(purpose="Manufacture", work_order=None)
        self.assertIsNone(on_manufacture_submit(se, method="on_submit"))


from upande_scp.serverscripts.spray_plan_creator.auto_material_issue import (
    resolve_supervisor_employee,
)


def _ensure_user(email: str) -> None:
    """Create a minimal User record if missing."""
    if frappe.db.exists("User", email):
        return
    user = frappe.get_doc({
        "doctype": "User",
        "email": email,
        "first_name": email.split("@")[0],
        "send_welcome_email": 0,
    })
    user.flags.ignore_mandatory = True
    user.flags.ignore_permissions = True
    user.insert(ignore_permissions=True)


def _ensure_employee(emp_id: str, employee_name: str = "", user_id: str = "") -> str:
    """Create the Employee record if missing; return its name.

    Uses ``frappe.flags.in_migrate`` to suppress server-script doc-event
    handlers that would otherwise fire and reject the insert.
    """
    if frappe.db.exists("Employee", emp_id):
        return emp_id
    if user_id:
        _ensure_user(user_id)
    doc = frappe.get_doc({
        "doctype": "Employee",
        "employee_number": emp_id,
        "employee_name": employee_name or emp_id,
        "first_name": employee_name or emp_id,
        "gender": "Male",
        "date_of_birth": "1990-01-01",
        "date_of_joining": "2020-01-01",
        "status": "Active",
        "user_id": user_id or None,
    })
    doc.flags.ignore_mandatory = True
    _prev = frappe.flags.in_migrate
    frappe.flags.in_migrate = True
    try:
        doc.insert(ignore_permissions=True)
    finally:
        frappe.flags.in_migrate = _prev
    return doc.name


class _FakeWO:
    """Minimal stand-in for a Work Order doc — only the fields the helpers read."""

    def __init__(self, name="MFG-WO-FAKE", custom_spray_plan_team_members=None,
                 company="_Test Company", custom_cost_center=None):
        self.name = name
        self.custom_spray_plan_team_members = custom_spray_plan_team_members or []
        self.company = company
        self.custom_cost_center = custom_cost_center


class _TeamRow:
    def __init__(self, employee, role):
        self.employee = employee
        self.role = role


class TestResolveSupervisorEmployee(FrappeTestCase):
    def test_picks_first_supervisor_row(self):
        emp = _ensure_employee("EMP-SUP-1", "Supervisor One")
        _ensure_employee("EMP-SPR-1", "Sprayer One")
        wo = _FakeWO(custom_spray_plan_team_members=[
            _TeamRow("EMP-SPR-1", "Sprayer"),
            _TeamRow(emp, "Supervisor"),
            _TeamRow("EMP-SUP-OTHER", "Supervisor"),
        ])
        self.assertEqual(resolve_supervisor_employee(wo), emp)

    def test_role_match_is_case_insensitive(self):
        emp = _ensure_employee("EMP-SUP-2", "Supervisor Two")
        wo = _FakeWO(custom_spray_plan_team_members=[
            _TeamRow(emp, "  supervisor  "),
        ])
        self.assertEqual(resolve_supervisor_employee(wo), emp)

    def test_fallback_to_session_user_employee(self):
        emp = _ensure_employee("EMP-USR-1", "Session User",
                                user_id="auto_mi_user@example.com")
        frappe.set_user("auto_mi_user@example.com")
        try:
            wo = _FakeWO(custom_spray_plan_team_members=[])
            self.assertEqual(resolve_supervisor_employee(wo), emp)
        finally:
            frappe.set_user("Administrator")

    def test_throws_when_neither_resolvable(self):
        # A session user with no Employee link, no team members.
        frappe.set_user("Administrator")  # Administrator has no Employee record.
        wo = _FakeWO(custom_spray_plan_team_members=[])
        with self.assertRaises(frappe.ValidationError):
            resolve_supervisor_employee(wo)
