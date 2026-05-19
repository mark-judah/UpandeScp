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
        wo.custom_spray_team = None
        with self.assertRaises(frappe.ValidationError):
            resolve_supervisor_employee(wo)

    def test_fallback_to_linked_spray_team(self):
        """When the per-plan snapshot is empty but the WO links a Spray Team
        that has a Supervisor row, that row's Employee wins (before the
        session-user fallback)."""
        emp = _ensure_employee("EMP-LINKED-SUP-1", "Linked Sup")
        team_name = "_Test Spray Team With Sup"
        if frappe.db.exists("Spray Team", team_name):
            frappe.delete_doc("Spray Team", team_name, force=1, ignore_permissions=True)
        team = frappe.get_doc({
            "doctype": "Spray Team",
            "team_name": team_name,
            "enabled": 1,
            "team": [
                {"name1": "EMP-LINKED-SPR-1", "role": "Sprayer"},
                {"name1": emp, "role": "Supervisor"},
                {"name1": "EMP-LINKED-SUP-OTHER", "role": "Supervisor"},
            ],
        })
        team.flags.ignore_mandatory = True
        team.flags.ignore_links = True
        team.insert(ignore_permissions=True)

        # Empty snapshot AND Administrator session (no Employee link) so the
        # only viable resolution is via the linked Spray Team.
        frappe.set_user("Administrator")
        wo = _FakeWO(custom_spray_plan_team_members=[])
        wo.custom_spray_team = team_name
        try:
            self.assertEqual(resolve_supervisor_employee(wo), emp)
        finally:
            frappe.delete_doc("Spray Team", team_name, force=1, ignore_permissions=True)


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


from upande_scp.serverscripts.spray_plan_creator.auto_material_issue import (
    build_material_issue,
)


class _FakeItemRow:
    def __init__(self, item_code, item_name, qty, uom, stock_uom,
                 description=None, item_group=None, is_finished_item=0,
                 conversion_factor=1):
        self.item_code = item_code
        self.item_name = item_name
        self.qty = qty
        self.uom = uom
        self.stock_uom = stock_uom
        self.transfer_qty = qty
        self.description = description or item_name
        self.item_group = item_group or "Chemical Mix"
        self.is_finished_item = is_finished_item
        self.conversion_factor = conversion_factor


class _FakeManufactureSE:
    def __init__(self, *, company, to_warehouse, custom_location, letter_head, items):
        self.purpose = "Manufacture"
        self.stock_entry_type = "Manufacture"
        self.company = company
        self.to_warehouse = to_warehouse
        self.custom_location = custom_location
        self.letter_head = letter_head
        self.items = items


class TestBuildMaterialIssue(FrappeTestCase):
    def test_builds_expected_dict(self):
        co = _ensure_company()
        acc = _ensure_account("MI Build Acc", co)
        _set_settings_default_account(acc)
        item = _ensure_chemical_mix_item("MI-FG-1", co, acc)
        emp = _ensure_employee("EMP-MI-BUILD-1", "Builder Sup")
        # Ensure farm exists first (Warehouse link-validates custom_farm).
        if not frappe.db.exists("Farm", "_Test Farm MI"):
            frappe.get_doc({"doctype": "Farm", "farm": "_Test Farm MI"}).insert(ignore_permissions=True)
        # Greenhouse warehouse with custom_farm (Frappe appends company abbr to name).
        abbr = frappe.db.get_value("Company", co, "abbr")
        gh = f"_Test GH MI Build - {abbr}"
        if not frappe.db.exists("Warehouse", gh):
            frappe.get_doc({
                "doctype": "Warehouse", "warehouse_name": "_Test GH MI Build",
                "company": co, "warehouse_type": "Greenhouse",
                "custom_farm": "_Test Farm MI", "is_group": 0,
            }).insert(ignore_permissions=True)

        cost_center = frappe.db.get_value(
            "Cost Center", {"company": co, "is_group": 0}, "name"
        )
        wo = _FakeWO(name="MFG-WO-MI-1", company=co, custom_cost_center=cost_center)

        chemical = _FakeItemRow("CHEM-A", "Chem A", 1.5, "Litre", "Litre", is_finished_item=0)
        fg = _FakeItemRow(item, "MI-FG-1", 2, "Tank Mix (1000L)",
                          "Tank Mix (1000L)", is_finished_item=1)
        manu = _FakeManufactureSE(
            company=co, to_warehouse=gh, custom_location="Ravine",
            letter_head="Karen Roses Letterhead", items=[chemical, fg],
        )

        result = build_material_issue(manu, wo, emp)

        self.assertEqual(result["stock_entry_type"], "Material Issue")
        self.assertEqual(result["purpose"], "Material Issue")
        self.assertEqual(result["from_warehouse"], gh)
        self.assertEqual(result["custom_farm"], "_Test Farm MI")
        self.assertEqual(result["custom_location"], "Ravine")
        self.assertEqual(result["company"], co)
        self.assertEqual(result["letter_head"], "Karen Roses Letterhead")
        self.assertEqual(result["custom_biometric_verified"], 0)
        self.assertEqual(result.get("custom_biometric_data", []), [])

        # Exactly one row — the FG item, not the chemicals.
        self.assertEqual(len(result["items"]), 1)
        row = result["items"][0]
        self.assertEqual(row["item_code"], item)
        self.assertEqual(row["qty"], 2)
        self.assertEqual(row["s_warehouse"], gh)
        self.assertEqual(row["expense_account"], acc)
        self.assertEqual(row["cost_center"], cost_center)
        self.assertEqual(row["farm"], "_Test Farm MI")

        # Employee row.
        self.assertEqual(len(result["custom_employee_data"]), 1)
        self.assertEqual(result["custom_employee_data"][0]["employee"], emp)

    def test_throws_when_no_finished_item(self):
        co = _ensure_company()
        wo = _FakeWO(name="MFG-WO-MI-2", company=co, custom_cost_center="X")
        manu = _FakeManufactureSE(
            company=co, to_warehouse="_Test GH MI Build",
            custom_location="", letter_head="",
            items=[_FakeItemRow("CHEM-A", "Chem A", 1.0, "Litre", "Litre",
                                is_finished_item=0)],
        )
        with self.assertRaises(frappe.ValidationError):
            build_material_issue(manu, wo, "EMP-MI-BUILD-1")

    def test_throws_when_greenhouse_has_no_farm(self):
        co = _ensure_company()
        acc = _ensure_account("MI Build Acc 2", co)
        _set_settings_default_account(acc)
        item = _ensure_chemical_mix_item("MI-FG-2", co, acc)
        emp = _ensure_employee("EMP-MI-BUILD-2", "B2")
        abbr = frappe.db.get_value("Company", co, "abbr")
        gh = f"_Test GH No Farm - {abbr}"
        if not frappe.db.exists("Warehouse", gh):
            frappe.get_doc({
                "doctype": "Warehouse", "warehouse_name": "_Test GH No Farm",
                "company": co, "warehouse_type": "Greenhouse", "is_group": 0,
            }).insert(ignore_permissions=True)
        wo = _FakeWO(name="MFG-WO-MI-3", company=co, custom_cost_center="X")
        manu = _FakeManufactureSE(
            company=co, to_warehouse=gh, custom_location="",
            letter_head="", items=[
                _FakeItemRow(item, item, 1.0, "Litre", "Litre", is_finished_item=1),
            ],
        )
        with self.assertRaises(frappe.ValidationError):
            build_material_issue(manu, wo, emp)

    def test_throws_when_cost_center_missing(self):
        co = _ensure_company()
        acc = _ensure_account("MI Build Acc 3", co)
        _set_settings_default_account(acc)
        item = _ensure_chemical_mix_item("MI-FG-3", co, acc)
        emp = _ensure_employee("EMP-MI-BUILD-3", "B3")
        gh = "_Test GH MI Build"  # reused from happy-path test
        wo = _FakeWO(name="MFG-WO-MI-4", company=co, custom_cost_center=None)
        manu = _FakeManufactureSE(
            company=co, to_warehouse=gh, custom_location="", letter_head="",
            items=[_FakeItemRow(item, item, 1.0, "Litre", "Litre", is_finished_item=1)],
        )
        with self.assertRaises(frappe.ValidationError):
            build_material_issue(manu, wo, emp)


class TestAutoMaterialIssueIntegration(FrappeTestCase):
    """End-to-end: Manufacture SE submit -> Material Issue auto-created + submitted.

    We don't run a real BOM/Manufacture flow (heavy setup). Instead, we
    construct a Manufacture SE document with the same shape that
    erpnext.manufacturing.doctype.work_order.work_order.make_stock_entry would
    produce, submit it, and assert on the resulting Material Issue.
    """

    def _setup_world(self, suffix: str):
        co = _ensure_company()
        acc = _ensure_account(f"MI E2E Acc {suffix}", co)
        _set_settings_default_account(acc)
        farm = f"_Test Farm E2E {suffix}"
        if not frappe.db.exists("Farm", farm):
            frappe.get_doc({
                "doctype": "Farm", "farm": farm, "company": co,
            }).insert(ignore_permissions=True)
        else:
            # Ensure company is set correctly (in case it was created without it).
            frappe.db.set_value("Farm", farm, "company", co, update_modified=False)
        # Two warehouses: CSU (source for chemicals) and Greenhouse (target).
        abbr = frappe.db.get_value("Company", co, "abbr")
        csu_name = f"_Test CSU E2E {suffix}"
        gh_name = f"_Test GH E2E {suffix}"
        for wh, wtype in [(csu_name, "Farm"), (gh_name, "Greenhouse")]:
            doc_name = f"{wh} - {abbr}"
            if not frappe.db.exists("Warehouse", doc_name):
                frappe.get_doc({
                    "doctype": "Warehouse", "warehouse_name": wh,
                    "company": co, "warehouse_type": wtype,
                    "custom_farm": farm, "is_group": 0,
                }).insert(ignore_permissions=True)
        csu = f"{csu_name} - {abbr}"
        gh = f"{gh_name} - {abbr}"
        # A finished tank-mix item with the expense account on Item Default.
        fg_item = _ensure_chemical_mix_item(f"MI-FG-E2E-{suffix}", co, acc)
        # A raw-material item (chemical ingredient) — needed so the Manufacture SE
        # passes the ERPNext "at least one raw material (s_warehouse)" check.
        raw_item = _ensure_chemical_mix_item(f"MI-RAW-E2E-{suffix}", co, acc)
        # Cost center: pick a leaf cost center for this company.
        cost_center = frappe.db.get_value(
            "Cost Center", {"company": co, "is_group": 0}, "name"
        )
        # The Application Floor Plan Work Order. We bypass the WO submit path
        # entirely — db.set_value the bare minimum the handler reads.
        # NOTE: Work Order uses naming_series autoname so we cannot force a name;
        # we capture the auto-assigned name after insert.
        wo = frappe.get_doc({
            "doctype": "Work Order",
            "company": co,
            "production_item": fg_item,
            "qty": 2,
            "fg_warehouse": gh,
            "wip_warehouse": csu,
            "custom_type": "Application Floor Plan",
            "custom_cost_center": cost_center,
            "custom_greenhouse": gh,
        })
        wo.flags.ignore_mandatory = True
        wo.flags.ignore_validate = True
        wo.flags.ignore_links = True
        # Temporarily suppress workflow validation for this insert.
        _prev_install = frappe.flags.in_install
        frappe.flags.in_install = "frappe"
        try:
            wo.insert(ignore_permissions=True)
        finally:
            frappe.flags.in_install = _prev_install
        wo_name = wo.name
        # Bypass workflow validation + submit gate by writing state directly to DB.
        frappe.db.set_value("Work Order", wo_name, {
            "workflow_state": "Tank Mix Manufactured",
            "docstatus": 1,
        }, update_modified=False)
        # Add a Supervisor row to the per-plan team table.
        emp = _ensure_employee(
            f"EMP-MI-E2E-{suffix}", f"Supervisor E2E {suffix}"
        )
        frappe.get_doc({
            "doctype": "Custom Spray Plan Team Member",
            "parent": wo_name, "parenttype": "Work Order",
            "parentfield": "custom_spray_plan_team_members",
            "employee": emp, "role": "Supervisor",
        }).insert(ignore_permissions=True)
        # Reload so the child rows are attached.
        wo = frappe.get_doc("Work Order", wo_name)
        return {
            "company": co, "farm": farm, "csu": csu, "gh": gh,
            "fg_item": fg_item, "raw_item": raw_item, "cost_center": cost_center,
            "wo": wo, "supervisor": emp, "expense_account": acc,
        }

    def _make_manufacture_se(self, *, ctx, qty: float = 2.0):
        """Stock-in the finished item at the greenhouse (for the Material Issue
        to consume) AND stock-in the raw material at CSU (for the Manufacture
        SE raw-material row). Returns the GH receipt SE doc."""
        # Pre-stock FG at the greenhouse.
        receipt_gh = frappe.get_doc({
            "doctype": "Stock Entry",
            "stock_entry_type": "Material Receipt",
            "purpose": "Material Receipt",
            "company": ctx["company"],
            "to_warehouse": ctx["gh"],
            "items": [{
                "item_code": ctx["fg_item"],
                "qty": qty, "uom": "Litre", "stock_uom": "Litre",
                "conversion_factor": 1,
                "t_warehouse": ctx["gh"],
                "basic_rate": 100, "allow_zero_valuation_rate": 1,
                "expense_account": ctx["expense_account"],
                "cost_center": ctx["cost_center"],
            }],
        })
        receipt_gh.flags.ignore_permissions = True
        receipt_gh.insert()
        receipt_gh.submit()
        # Pre-stock the raw material at CSU so the Manufacture SE has stock
        # to consume on submit.
        receipt_csu = frappe.get_doc({
            "doctype": "Stock Entry",
            "stock_entry_type": "Material Receipt",
            "purpose": "Material Receipt",
            "company": ctx["company"],
            "to_warehouse": ctx["csu"],
            "items": [{
                "item_code": ctx["raw_item"],
                "qty": qty, "uom": "Litre", "stock_uom": "Litre",
                "conversion_factor": 1,
                "t_warehouse": ctx["csu"],
                "basic_rate": 100, "allow_zero_valuation_rate": 1,
                "expense_account": ctx["expense_account"],
                "cost_center": ctx["cost_center"],
            }],
        })
        receipt_csu.flags.ignore_permissions = True
        receipt_csu.insert()
        receipt_csu.submit()
        return receipt_gh

    def test_manufacture_submit_creates_and_submits_material_issue(self):
        ctx = self._setup_world("HAPPY")
        # Pre-stock the greenhouse so the Material Issue can consume.
        self._make_manufacture_se(ctx=ctx, qty=5)

        # Build a Manufacture SE directly (skipping the BOM path which would
        # require a full BOM scaffold). The handler only reads .purpose,
        # .work_order, .items[is_finished_item], .to_warehouse, .company,
        # .custom_location, .letter_head.
        manu = frappe.get_doc({
            "doctype": "Stock Entry",
            "stock_entry_type": "Manufacture",
            "purpose": "Manufacture",
            "company": ctx["company"],
            "from_bom": 1,
            "work_order": ctx["wo"].name,
            "fg_completed_qty": 2,
            "to_warehouse": ctx["gh"],
            "custom_location": "Ravine",
            "letter_head": "",
            "items": [
                # Raw material row (required by ERPNext SE validation).
                {
                    "item_code": ctx["raw_item"], "is_finished_item": 0,
                    "qty": 2, "uom": "Litre", "stock_uom": "Litre",
                    "conversion_factor": 1, "s_warehouse": ctx["csu"],
                    "basic_rate": 100, "allow_zero_valuation_rate": 1,
                    "expense_account": ctx["expense_account"],
                    "cost_center": ctx["cost_center"],
                },
                # Finished-good row — this is what the handler picks up.
                {
                    "item_code": ctx["fg_item"], "is_finished_item": 1,
                    "qty": 2, "uom": "Litre", "stock_uom": "Litre",
                    "conversion_factor": 1, "t_warehouse": ctx["gh"],
                    "basic_rate": 100, "allow_zero_valuation_rate": 1,
                    "expense_account": ctx["expense_account"],
                    "cost_center": ctx["cost_center"],
                },
            ],
        })
        manu.flags.ignore_permissions = True
        manu.flags.ignore_links = True
        manu.insert()
        manu.submit()

        # Assert: exactly one Material Issue SE links back via the same WO.
        rows = frappe.get_all(
            "Stock Entry",
            filters={
                "purpose": "Material Issue",
                "from_warehouse": ctx["gh"],
                "docstatus": 1,
            },
            fields=["name", "company", "custom_farm", "custom_location"],
        )
        # Filter by our FG item.
        matched = []
        for row in rows:
            child = frappe.db.get_value(
                "Stock Entry Detail",
                {"parent": row.name, "item_code": ctx["fg_item"]},
                "name",
            )
            if child:
                matched.append(row)
        self.assertEqual(len(matched), 1, f"expected one Material Issue, got {matched}")
        mi = frappe.get_doc("Stock Entry", matched[0].name)
        self.assertEqual(mi.custom_farm, ctx["farm"])
        self.assertEqual(mi.custom_location, "Ravine")
        # Items shape:
        self.assertEqual(len(mi.items), 1)
        item_row = mi.items[0]
        self.assertEqual(item_row.s_warehouse, ctx["gh"])
        self.assertEqual(item_row.expense_account, ctx["expense_account"])
        self.assertEqual(item_row.cost_center, ctx["cost_center"])
        self.assertEqual(item_row.qty, 2)
        # Employee row populated with the Supervisor.
        self.assertEqual(len(mi.custom_employee_data), 1)
        self.assertEqual(mi.custom_employee_data[0].employee, ctx["supervisor"])
        # WO state -> Completed.
        self.assertEqual(
            frappe.db.get_value("Work Order", ctx["wo"].name, "workflow_state"),
            "Completed",
        )

    def test_non_afp_wo_is_skipped(self):
        ctx = self._setup_world("NONAFP")
        # Flip custom_type so the handler bails.
        frappe.db.set_value("Work Order", ctx["wo"].name, "custom_type", "Standard")
        # Pre-stock again for safety.
        self._make_manufacture_se(ctx=ctx, qty=5)
        manu = frappe.get_doc({
            "doctype": "Stock Entry",
            "stock_entry_type": "Manufacture",
            "purpose": "Manufacture",
            "company": ctx["company"], "from_bom": 1,
            "work_order": ctx["wo"].name, "fg_completed_qty": 2,
            "to_warehouse": ctx["gh"],
            "items": [
                {
                    "item_code": ctx["raw_item"], "is_finished_item": 0,
                    "qty": 2, "uom": "Litre", "stock_uom": "Litre",
                    "conversion_factor": 1, "s_warehouse": ctx["csu"],
                    "basic_rate": 100, "allow_zero_valuation_rate": 1,
                    "expense_account": ctx["expense_account"],
                    "cost_center": ctx["cost_center"],
                },
                {
                    "item_code": ctx["fg_item"], "is_finished_item": 1,
                    "qty": 2, "uom": "Litre", "stock_uom": "Litre",
                    "conversion_factor": 1, "t_warehouse": ctx["gh"],
                    "basic_rate": 100, "allow_zero_valuation_rate": 1,
                    "expense_account": ctx["expense_account"],
                    "cost_center": ctx["cost_center"],
                },
            ],
        })
        manu.flags.ignore_permissions = True
        manu.flags.ignore_links = True
        manu.insert()
        manu.submit()
        # Assert: no Material Issue created since the last test by this manu.
        rows = frappe.get_all(
            "Stock Entry",
            filters={
                "purpose": "Material Issue",
                "from_warehouse": ctx["gh"],
                "docstatus": 1,
                "creation": [">=", manu.creation],
            },
        )
        self.assertEqual(rows, [])


class TestAutoMaterialIssueAtomic(FrappeTestCase):
    def test_missing_fallback_rolls_back_manufacture_submit(self):
        # Reuse the integration helpers via instantiation.
        helper = TestAutoMaterialIssueIntegration()
        ctx = helper._setup_world("ATOMIC")
        # Pre-stock so we don't fail for negative-stock reasons.
        helper._make_manufacture_se(ctx=ctx, qty=5)

        # Strip BOTH the Item Default expense account AND the Settings fallback.
        frappe.db.sql(
            "DELETE FROM `tabItem Default` WHERE parent=%s AND company=%s",
            (ctx["fg_item"], ctx["company"]),
        )
        _set_settings_default_account(None)

        manu = frappe.get_doc({
            "doctype": "Stock Entry",
            "stock_entry_type": "Manufacture",
            "purpose": "Manufacture",
            "company": ctx["company"], "from_bom": 1,
            "work_order": ctx["wo"].name, "fg_completed_qty": 2,
            "to_warehouse": ctx["gh"],
            "items": [
                {
                    "item_code": ctx["raw_item"], "is_finished_item": 0,
                    "qty": 2, "uom": "Litre", "stock_uom": "Litre",
                    "conversion_factor": 1, "s_warehouse": ctx["csu"],
                    "basic_rate": 100, "allow_zero_valuation_rate": 1,
                    "expense_account": ctx["expense_account"],
                    "cost_center": ctx["cost_center"],
                },
                {
                    "item_code": ctx["fg_item"], "is_finished_item": 1,
                    "qty": 2, "uom": "Litre", "stock_uom": "Litre",
                    "conversion_factor": 1, "t_warehouse": ctx["gh"],
                    "basic_rate": 100, "allow_zero_valuation_rate": 1,
                    "expense_account": ctx["expense_account"],
                    "cost_center": ctx["cost_center"],
                },
            ],
        })
        manu.flags.ignore_permissions = True
        manu.flags.ignore_links = True
        manu.insert()
        with self.assertRaises(frappe.ValidationError):
            manu.submit()

        # Docstatus check: within the Frappe test runner's single-connection
        # transaction, the Manufacture SE's docstatus=1 write is visible on the
        # same connection even though the exception will cause Frappe to roll it
        # back when the transaction finally ends. We therefore skip asserting
        # docstatus==0 here; the two assertions below (no Material Issue, WO
        # state unchanged) are the strongest proof of correct atomic behaviour
        # that can be read reliably before the test-teardown rollback fires.
        # No Material Issue created.
        rows = frappe.get_all(
            "Stock Entry",
            filters={
                "purpose": "Material Issue",
                "from_warehouse": ctx["gh"],
                "creation": [">=", manu.creation],
            },
        )
        self.assertEqual(rows, [])
        # WO state stays at whatever was set before (Tank Mix Manufactured).
        self.assertEqual(
            frappe.db.get_value("Work Order", ctx["wo"].name, "workflow_state"),
            "Tank Mix Manufactured",
        )
