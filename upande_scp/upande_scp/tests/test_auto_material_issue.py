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


from upande_scp.serverscripts.spray_plan_creator.auto_material_issue import (
    resolve_expense_account,
)


def _ensure_company(name: str = "_Test Auto MI Co", abbr: str = "TAMC") -> str:
    if frappe.db.exists("Company", name):
        return name
    doc = frappe.get_doc({
        "doctype": "Company",
        "company_name": name,
        "abbr": abbr,
        "default_currency": "KES",
        "country": "Kenya",
    })
    doc.flags.ignore_mandatory = True
    doc.insert(ignore_permissions=True)
    return name


def _ensure_account(name: str, company: str, account_type: str = "Expense Account") -> str:
    """Create a leaf Account under the company's tree. Returns the docname."""
    abbr = frappe.db.get_value("Company", company, "abbr")
    docname = f"{name} - {abbr}"
    if frappe.db.exists("Account", docname):
        return docname
    parent = frappe.db.get_value(
        "Account",
        {"company": company, "is_group": 1, "account_type": ["in", ["", "Expense Account"]]},
        "name",
        order_by="lft ASC",
    )
    if not parent:
        # Pick any group as parent.
        parent = frappe.db.get_value("Account", {"company": company, "is_group": 1}, "name")
    doc = frappe.get_doc({
        "doctype": "Account",
        "account_name": name,
        "parent_account": parent,
        "company": company,
        "account_type": account_type,
        "is_group": 0,
    })
    doc.flags.ignore_mandatory = True
    doc.insert(ignore_permissions=True)
    return doc.name


def _ensure_chemical_mix_item(code: str, company: str | None = None,
                              expense_account: str | None = None) -> str:
    if frappe.db.exists("Item", code):
        frappe.delete_doc("Item", code, force=1, ignore_permissions=True)
    item_group = "Chemical Mix" if frappe.db.exists("Item Group", "Chemical Mix") else "All Item Groups"
    doc = frappe.get_doc({
        "doctype": "Item",
        "item_code": code,
        "item_name": code,
        "item_group": item_group,
        "stock_uom": "Litre",
    })
    if company and expense_account:
        doc.append("item_defaults", {
            "company": company,
            "expense_account": expense_account,
        })
    doc.flags.ignore_mandatory = True
    doc.insert(ignore_permissions=True)
    return doc.name


def _set_settings_default_account(account: str | None) -> None:
    settings = frappe.get_single("Spray Plan Settings")
    settings.default_chemical_expense_account = account or ""
    settings.flags.ignore_permissions = True
    settings.flags.ignore_validate = True
    settings.save()


class TestResolveExpenseAccount(FrappeTestCase):
    def test_item_default_wins(self):
        co = _ensure_company()
        item_acc = _ensure_account("Chemicals Expense MI Test", co)
        fallback = _ensure_account("Fallback MI Test", co)
        _set_settings_default_account(fallback)
        item = _ensure_chemical_mix_item("MI-TANK-1", co, item_acc)
        self.assertEqual(resolve_expense_account(item, co), item_acc)

    def test_falls_back_to_spray_plan_settings(self):
        co = _ensure_company()
        fallback = _ensure_account("Fallback MI Test 2", co)
        _set_settings_default_account(fallback)
        item = _ensure_chemical_mix_item("MI-TANK-2", co, None)  # no Item Default
        self.assertEqual(resolve_expense_account(item, co), fallback)

    def test_throws_when_neither_set(self):
        co = _ensure_company()
        _set_settings_default_account(None)
        item = _ensure_chemical_mix_item("MI-TANK-3", co, None)
        with self.assertRaises(frappe.ValidationError):
            resolve_expense_account(item, co)
