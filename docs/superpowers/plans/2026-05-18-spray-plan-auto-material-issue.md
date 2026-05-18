# Spray Plan — Auto Material Issue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the Manufacture Stock Entry for an Application Floor Plan Work Order is submitted, atomically create + submit a Material Issue SE that consumes the manufactured tank-mix from the greenhouse warehouse; advance the WO workflow to `Completed`. Plus: hide the "Access Control" sidebar entry from non-General-Managers.

**Architecture:** A single `Stock Entry.on_submit` doc-event hook detects Manufacture SEs linked to Application Floor Plan WOs and runs a self-contained module (`auto_material_issue.py`) that resolves the supervisor / expense account / cost-center, builds the Material Issue dict, inserts + submits it, and advances the workflow — all inside the same Frappe transaction as the triggering submit. Frontend: extend the server-rendered `scp_app` bootstrap with a `roles` array and filter the sidebar NAV at render time.

**Tech Stack:** Frappe v15, ERPNext stock module, Python 3.10, pytest (`FrappeTestCase`), React + TypeScript + Vite, Vitest, shadcn/ui.

**Spec:** [docs/superpowers/specs/2026-05-18-spray-plan-auto-material-issue-design.md](../specs/2026-05-18-spray-plan-auto-material-issue-design.md)

---

## File Structure

**New files:**

- `upande_scp/serverscripts/spray_plan_creator/auto_material_issue.py` — hook handler + the three pure helpers (`resolve_supervisor_employee`, `resolve_expense_account`, `build_material_issue`).
- `upande_scp/upande_scp/tests/test_auto_material_issue.py` — backend test suite (happy + fallback + atomic + non-AFP).
- `frontend/src/components/__tests__/AppSidebar.test.tsx` — frontend role-gating test (Vitest).

**Modified files:**

- `upande_scp/upande_scp/doctype/spray_plan_settings/spray_plan_settings.json` — add `default_chemical_expense_account` Link field.
- `upande_scp/hooks.py` — register `Stock Entry.on_submit` doc event.
- `upande_scp/www/scp_app.py` — emit `roles: list[str]` into the inlined bootstrap.
- `frontend/src/lib/frappe.ts` — add `roles` to `ScpBootstrap`.
- `frontend/src/components/AppSidebar.tsx` — filter NAV by `requireRoles` per item.

---

## Task 1: Add `default_chemical_expense_account` to Spray Plan Settings

**Files:**
- Modify: `upande_scp/upande_scp/doctype/spray_plan_settings/spray_plan_settings.json`

The field appears in a new "Material Issue Defaults" section, after the existing weather thresholds.

- [ ] **Step 1: Edit the doctype JSON**

In `spray_plan_settings.json`, append `"material_issue_section"` and `"default_chemical_expense_account"` to `field_order` (end of the array, before the closing bracket on line 25). Then add the two field rows inside the `fields` array (just before the closing `]` on line 75):

```json
  {"fieldname": "material_issue_section", "fieldtype": "Section Break", "label": "Material Issue Defaults"},
  {"fieldname": "default_chemical_expense_account", "fieldtype": "Link", "options": "Account", "label": "Default Chemical Expense Account", "description": "Used as the fallback expense account on auto-Material-Issue rows when the tank-mix Item has no Item Default for the Work Order's company."}
```

Also bump `"modified"` to a current timestamp (e.g. `"2026-05-18 00:00:01.000000"`).

- [ ] **Step 2: Apply the doctype change**

```bash
cd /home/ubuntu/stive/code/frappe15
bench --site kaitet.local migrate
```

Expected: `Updated DocType Spray Plan Settings` in the migrate output. No errors.

- [ ] **Step 3: Verify the field exists**

```bash
bench --site kaitet.local mariadb -e "SELECT fieldname, fieldtype, options FROM \`tabDocField\` WHERE parent='Spray Plan Settings' AND fieldname='default_chemical_expense_account';"
```

Expected: one row showing `default_chemical_expense_account | Link | Account`.

- [ ] **Step 4: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp/upande_scp/doctype/spray_plan_settings/spray_plan_settings.json
git commit -m "feat(spray-plan): add Spray Plan Settings.default_chemical_expense_account"
```

---

## Task 2: Scaffold `auto_material_issue.py` with no-op handler

Set up the module with the entry handler that exits early for non-Manufacture or non-AFP Work Orders. No real work happens yet — this task only proves the hook fires and is gated correctly.

**Files:**
- Create: `upande_scp/serverscripts/spray_plan_creator/auto_material_issue.py`
- Test: `upande_scp/upande_scp/tests/test_auto_material_issue.py`

- [ ] **Step 1: Write the failing test for the no-op path**

Create `upande_scp/upande_scp/tests/test_auto_material_issue.py` with:

```python
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/ubuntu/stive/code/frappe15
bench --site kaitet.local run-tests --app upande_scp --module upande_scp.upande_scp.tests.test_auto_material_issue
```

Expected: FAIL with `ImportError: cannot import name 'on_manufacture_submit'`.

- [ ] **Step 3: Create the module with the no-op handler**

Create `upande_scp/serverscripts/spray_plan_creator/auto_material_issue.py`:

```python
"""Auto-issue tank-mix on Manufacture Stock Entry submit.

When the Manufacture SE for an Application Floor Plan Work Order is submitted,
this handler atomically creates + submits a Material Issue SE that consumes
the manufactured tank-mix from the greenhouse warehouse. Workflow state advances
to ``Completed``.

The handler runs inside the same transaction as the Manufacture submit, so any
``frappe.throw`` here rolls the Manufacture submit back too.
"""
from __future__ import annotations

import frappe

AFP_TYPE = "Application Floor Plan"


def on_manufacture_submit(doc, method):
    """Stock Entry on_submit hook. No-op unless this is a Manufacture SE for
    an Application Floor Plan Work Order."""
    if getattr(doc, "purpose", None) != "Manufacture":
        return None
    work_order = getattr(doc, "work_order", None)
    if not work_order:
        return None

    wo_type = frappe.db.get_value("Work Order", work_order, "custom_type")
    if wo_type != AFP_TYPE:
        return None

    # Real work lands in subsequent tasks.
    return None
```

- [ ] **Step 4: Run the test — should pass**

```bash
bench --site kaitet.local run-tests --app upande_scp --module upande_scp.upande_scp.tests.test_auto_material_issue
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp/serverscripts/spray_plan_creator/auto_material_issue.py upande_scp/upande_scp/tests/test_auto_material_issue.py
git commit -m "feat(spray-plan): scaffold auto-material-issue handler with no-op early exits"
```

---

## Task 3: Implement `resolve_supervisor_employee`

Pure helper: pick the Supervisor's Employee id from the WO's per-plan team roster, falling back to the session user's Employee.

**Files:**
- Modify: `upande_scp/serverscripts/spray_plan_creator/auto_material_issue.py`
- Modify: `upande_scp/upande_scp/tests/test_auto_material_issue.py`

- [ ] **Step 1: Add the failing tests**

Append to `test_auto_material_issue.py`:

```python
from upande_scp.serverscripts.spray_plan_creator.auto_material_issue import (
    resolve_supervisor_employee,
)


def _ensure_employee(emp_id: str, employee_name: str = "", user_id: str = "") -> str:
    """Create the Employee record if missing; return its name."""
    if frappe.db.exists("Employee", emp_id):
        return emp_id
    doc = frappe.get_doc({
        "doctype": "Employee",
        "employee": emp_id,
        "employee_name": employee_name or emp_id,
        "first_name": employee_name or emp_id,
        "gender": "Male",
        "date_of_birth": "1990-01-01",
        "date_of_joining": "2020-01-01",
        "status": "Active",
        "user_id": user_id or None,
    })
    doc.flags.ignore_mandatory = True
    doc.insert(ignore_permissions=True)
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
```

- [ ] **Step 2: Run — expect FAIL on import of `resolve_supervisor_employee`**

```bash
bench --site kaitet.local run-tests --app upande_scp --module upande_scp.upande_scp.tests.test_auto_material_issue
```

Expected: ImportError.

- [ ] **Step 3: Implement the helper**

Append to `auto_material_issue.py` (above `on_manufacture_submit`):

```python
def resolve_supervisor_employee(wo) -> str:
    """Return the Employee id responsible for the auto Material Issue.

    Order of resolution:
      1. First row in ``wo.custom_spray_plan_team_members`` where
         ``role.strip().lower() == "supervisor"``.
      2. Fallback: ``Employee.user_id == frappe.session.user`` (most recent).
      3. Both missing -> ``frappe.throw``.
    """
    rows = getattr(wo, "custom_spray_plan_team_members", None) or []
    for row in rows:
        role = (getattr(row, "role", "") or "").strip().lower()
        if role == "supervisor" and getattr(row, "employee", None):
            return row.employee

    user = frappe.session.user
    if user and user not in ("Guest", "Administrator"):
        emp = frappe.db.get_value(
            "Employee",
            {"user_id": user, "status": "Active"},
            "name",
            order_by="modified DESC",
        )
        if emp:
            return emp

    frappe.throw(
        "Cannot auto-issue tank-mix: no Supervisor in the spray team and no "
        "Employee linked to the submitting user.",
        title="Auto Material Issue",
    )
```

- [ ] **Step 4: Run — expect PASS**

```bash
bench --site kaitet.local run-tests --app upande_scp --module upande_scp.upande_scp.tests.test_auto_material_issue
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp/serverscripts/spray_plan_creator/auto_material_issue.py upande_scp/upande_scp/tests/test_auto_material_issue.py
git commit -m "feat(spray-plan): resolve_supervisor_employee helper with session-user fallback"
```

---

## Task 4: Implement `resolve_expense_account`

Pure helper: pick the per-item expense account, with `Item Default` → `Spray Plan Settings.default_chemical_expense_account` → throw.

**Files:**
- Modify: `upande_scp/serverscripts/spray_plan_creator/auto_material_issue.py`
- Modify: `upande_scp/upande_scp/tests/test_auto_material_issue.py`

- [ ] **Step 1: Add failing tests**

Append to `test_auto_material_issue.py`:

```python
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
```

- [ ] **Step 2: Run — expect FAIL on import**

```bash
bench --site kaitet.local run-tests --app upande_scp --module upande_scp.upande_scp.tests.test_auto_material_issue
```

- [ ] **Step 3: Implement the helper**

Append to `auto_material_issue.py`:

```python
def resolve_expense_account(item_code: str, company: str) -> str:
    """Return the expense account to write on a Material Issue row.

    1. ``Item Default.expense_account`` for ``(item_code, company)`` if set.
    2. Fallback: ``Spray Plan Settings.default_chemical_expense_account``.
    3. Both missing -> throw with remediation guidance.
    """
    item_default = frappe.db.get_value(
        "Item Default",
        {"parent": item_code, "company": company},
        "expense_account",
    )
    if item_default:
        return item_default

    fallback = frappe.db.get_single_value(
        "Spray Plan Settings", "default_chemical_expense_account"
    )
    if fallback:
        return fallback

    frappe.throw(
        f"Cannot auto-issue tank-mix: item {item_code} has no Item Default "
        f"expense account for company {company}, and Spray Plan Settings has "
        f"no Default Chemical Expense Account configured. Set one of the two.",
        title="Auto Material Issue",
    )
```

- [ ] **Step 4: Run — expect PASS**

```bash
bench --site kaitet.local run-tests --app upande_scp --module upande_scp.upande_scp.tests.test_auto_material_issue
```

Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/spray_plan_creator/auto_material_issue.py upande_scp/upande_scp/tests/test_auto_material_issue.py
git commit -m "feat(spray-plan): resolve_expense_account helper with Settings fallback"
```

---

## Task 5: Implement `build_material_issue`

Pure assembler: given the source Manufacture SE doc + the resolved supervisor employee, return the dict that will become the Material Issue.

**Files:**
- Modify: `upande_scp/serverscripts/spray_plan_creator/auto_material_issue.py`
- Modify: `upande_scp/upande_scp/tests/test_auto_material_issue.py`

- [ ] **Step 1: Add the failing test**

Append to `test_auto_material_issue.py`:

```python
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
        # Greenhouse warehouse with custom_farm:
        gh = "_Test GH MI Build"
        if not frappe.db.exists("Warehouse", gh):
            frappe.get_doc({
                "doctype": "Warehouse", "warehouse_name": "_Test GH MI Build",
                "company": co, "warehouse_type": "Greenhouse",
                "custom_farm": "_Test Farm MI", "is_group": 0,
            }).insert(ignore_permissions=True)
        # Ensure farm exists.
        if not frappe.db.exists("Farm", "_Test Farm MI"):
            frappe.get_doc({"doctype": "Farm", "farm": "_Test Farm MI"}).insert(ignore_permissions=True)

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
        gh = "_Test GH No Farm"
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
```

- [ ] **Step 2: Run — expect FAIL on import**

```bash
bench --site kaitet.local run-tests --app upande_scp --module upande_scp.upande_scp.tests.test_auto_material_issue
```

- [ ] **Step 3: Implement the helper**

Append to `auto_material_issue.py`:

```python
from frappe.utils import now_datetime


def build_material_issue(manufacture_se, wo, supervisor_employee: str) -> dict:
    """Return a dict ready to ``frappe.get_doc()`` for the Material Issue.

    Throws (rolling back the triggering transaction) on any missing input.
    """
    if not getattr(wo, "custom_cost_center", None):
        frappe.throw(
            f"Cannot auto-issue tank-mix: Work Order {wo.name} has no "
            "custom_cost_center. Re-derive the cost center on the WO.",
            title="Auto Material Issue",
        )

    greenhouse = manufacture_se.to_warehouse
    if not greenhouse:
        frappe.throw(
            "Cannot auto-issue tank-mix: Manufacture Stock Entry has no "
            "to_warehouse (greenhouse).",
            title="Auto Material Issue",
        )
    farm = frappe.db.get_value("Warehouse", greenhouse, "custom_farm")
    if not farm:
        frappe.throw(
            f"Cannot auto-issue tank-mix: greenhouse warehouse {greenhouse} "
            "has no custom_farm.",
            title="Auto Material Issue",
        )

    fg_rows = [r for r in (manufacture_se.items or []) if getattr(r, "is_finished_item", 0)]
    if not fg_rows:
        frappe.throw(
            "Cannot auto-issue tank-mix: Manufacture has no finished-good row.",
            title="Auto Material Issue",
        )

    items = []
    for r in fg_rows:
        items.append({
            "item_code": r.item_code,
            "item_name": r.item_name,
            "description": r.description,
            "item_group": r.item_group,
            "qty": r.qty,
            "transfer_qty": getattr(r, "transfer_qty", r.qty),
            "uom": r.uom,
            "stock_uom": r.stock_uom,
            "conversion_factor": getattr(r, "conversion_factor", 1) or 1,
            "s_warehouse": greenhouse,
            "expense_account": resolve_expense_account(r.item_code, manufacture_se.company),
            "cost_center": wo.custom_cost_center,
            "farm": farm,
        })

    emp_meta = frappe.db.get_value(
        "Employee", supervisor_employee,
        ["employee_name", "department", "location"], as_dict=True
    ) or {}

    posting = now_datetime()
    return {
        "doctype": "Stock Entry",
        "stock_entry_type": "Material Issue",
        "purpose": "Material Issue",
        "company": manufacture_se.company,
        "posting_date": posting.date().isoformat(),
        "posting_time": posting.time().isoformat(),
        "set_posting_time": 1,
        "from_warehouse": greenhouse,
        "letter_head": manufacture_se.letter_head or "",
        "custom_farm": farm,
        "custom_location": manufacture_se.custom_location or "",
        "custom_biometric_verified": 0,
        "custom_biometric_data": [],
        "items": items,
        "custom_employee_data": [{
            "employee": supervisor_employee,
            "employee_name": emp_meta.get("employee_name") or supervisor_employee,
            "department": emp_meta.get("department") or "",
            "location": emp_meta.get("location") or "",
            "farm": farm,
        }],
    }
```

- [ ] **Step 4: Run — expect PASS (13 total)**

```bash
bench --site kaitet.local run-tests --app upande_scp --module upande_scp.upande_scp.tests.test_auto_material_issue
```

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/spray_plan_creator/auto_material_issue.py upande_scp/upande_scp/tests/test_auto_material_issue.py
git commit -m "feat(spray-plan): build_material_issue assembler"
```

---

## Task 6: Wire `on_manufacture_submit` end-to-end + register the hook

Glue the helpers together, insert + submit the Material Issue, advance the WO workflow, and add a comment. Then register the doc-event so the real flow can be exercised.

**Files:**
- Modify: `upande_scp/serverscripts/spray_plan_creator/auto_material_issue.py`
- Modify: `upande_scp/hooks.py:170-207`
- Modify: `upande_scp/upande_scp/tests/test_auto_material_issue.py`

- [ ] **Step 1: Add the integration test**

Append to `test_auto_material_issue.py`:

```python
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
            frappe.get_doc({"doctype": "Farm", "farm": farm}).insert(ignore_permissions=True)
        # Two warehouses: CSU (source for chemicals) and Greenhouse (target).
        csu = f"_Test CSU E2E {suffix}"
        gh = f"_Test GH E2E {suffix}"
        for wh, wtype in [(csu, "Work In Progress"), (gh, "Greenhouse")]:
            if not frappe.db.exists("Warehouse", wh):
                frappe.get_doc({
                    "doctype": "Warehouse", "warehouse_name": wh,
                    "company": co, "warehouse_type": wtype,
                    "custom_farm": farm, "is_group": 0,
                }).insert(ignore_permissions=True)
        # A finished tank-mix item with the expense account on Item Default.
        fg_item = _ensure_chemical_mix_item(f"MI-FG-E2E-{suffix}", co, acc)
        # Cost center: pick a leaf cost center for this company.
        cost_center = frappe.db.get_value(
            "Cost Center", {"company": co, "is_group": 0}, "name"
        )
        # The Application Floor Plan Work Order. We bypass the WO submit path
        # entirely — db.set_value the bare minimum the handler reads.
        wo_name = f"MFG-WO-MI-E2E-{suffix}"
        if frappe.db.exists("Work Order", wo_name):
            frappe.delete_doc("Work Order", wo_name, force=1, ignore_permissions=True)
        wo = frappe.get_doc({
            "doctype": "Work Order",
            "name": wo_name,
            "company": co,
            "production_item": fg_item,
            "qty": 2,
            "fg_warehouse": gh,
            "wip_warehouse": csu,
            "custom_type": "Application Floor Plan",
            "custom_cost_center": cost_center,
            "custom_greenhouse": gh,
            "workflow_state": "Tank Mix Manufactured",
        })
        wo.flags.ignore_mandatory = True
        wo.flags.ignore_validate = True
        wo.flags.ignore_links = True
        wo.insert(ignore_permissions=True)
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
            "fg_item": fg_item, "cost_center": cost_center,
            "wo": wo, "supervisor": emp, "expense_account": acc,
        }

    def _make_manufacture_se(self, *, ctx, qty: float = 2.0):
        """Stock-in the finished item at the greenhouse via a Material Receipt
        SE first (so the subsequent Material Issue has stock to consume).
        Returns the receipt SE doc."""
        receipt = frappe.get_doc({
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
        receipt.flags.ignore_permissions = True
        receipt.insert()
        receipt.submit()
        return receipt

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
            "from_bom": 0,
            "work_order": ctx["wo"].name,
            "fg_completed_qty": 2,
            "to_warehouse": ctx["gh"],
            "custom_location": "Ravine",
            "letter_head": "",
            "items": [{
                "item_code": ctx["fg_item"], "is_finished_item": 1,
                "qty": 2, "uom": "Litre", "stock_uom": "Litre",
                "conversion_factor": 1, "t_warehouse": ctx["gh"],
                "basic_rate": 100, "allow_zero_valuation_rate": 1,
                "expense_account": ctx["expense_account"],
                "cost_center": ctx["cost_center"],
            }],
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
            "company": ctx["company"], "from_bom": 0,
            "work_order": ctx["wo"].name, "fg_completed_qty": 2,
            "to_warehouse": ctx["gh"],
            "items": [{
                "item_code": ctx["fg_item"], "is_finished_item": 1,
                "qty": 2, "uom": "Litre", "stock_uom": "Litre",
                "conversion_factor": 1, "t_warehouse": ctx["gh"],
                "basic_rate": 100, "allow_zero_valuation_rate": 1,
                "expense_account": ctx["expense_account"],
                "cost_center": ctx["cost_center"],
            }],
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
```

- [ ] **Step 2: Run — expect FAIL (handler still no-ops)**

```bash
bench --site kaitet.local run-tests --app upande_scp --module upande_scp.upande_scp.tests.test_auto_material_issue
```

Expected: integration tests fail (no Material Issue created). The earlier tests still pass.

- [ ] **Step 3: Fill in the handler body**

Replace the bottom of `auto_material_issue.py` (the existing `on_manufacture_submit` function) with:

```python
def on_manufacture_submit(doc, method):
    """Stock Entry on_submit hook. No-op unless this is a Manufacture SE for
    an Application Floor Plan Work Order. On match, create + submit a Material
    Issue SE in the same transaction."""
    if getattr(doc, "purpose", None) != "Manufacture":
        return None
    work_order_name = getattr(doc, "work_order", None)
    if not work_order_name:
        return None

    wo_type = frappe.db.get_value("Work Order", work_order_name, "custom_type")
    if wo_type != AFP_TYPE:
        return None

    wo = frappe.get_doc("Work Order", work_order_name)
    supervisor = resolve_supervisor_employee(wo)
    payload = build_material_issue(doc, wo, supervisor)

    mi = frappe.get_doc(payload)
    mi.flags.ignore_permissions = True
    mi.flags.ignore_links = True
    mi.insert()
    mi.submit()

    frappe.db.set_value(
        "Work Order", work_order_name, "workflow_state", "Completed",
        update_modified=True,
    )
    try:
        wo.add_comment(
            "Workflow",
            f"Auto Material Issue {mi.name} submitted by {frappe.session.user}. "
            "State: Tank Mix Manufactured -> Completed.",
        )
    except Exception:
        # Comment failures must not block the submission chain.
        pass
    return mi.name
```

- [ ] **Step 4: Register the hook in `hooks.py`**

Find the `doc_events = { ... }` block in [hooks.py](../../upande_scp/hooks.py) (currently lines 170-207). Inside the dict, add a new entry **after** the existing `"Scouting Entry": _SCP_SCOUTING_EVENTS,` line and before the closing `}`:

```python
    # Auto-create + submit the Material Issue when a Manufacture Stock Entry
    # for an Application Floor Plan Work Order is submitted. Runs in the same
    # transaction as the submit — any throw rolls the submit back.
    "Stock Entry": {
        "on_submit": "upande_scp.serverscripts.spray_plan_creator.auto_material_issue.on_manufacture_submit",
    },
```

- [ ] **Step 5: Run — expect PASS (15 total)**

```bash
bench --site kaitet.local run-tests --app upande_scp --module upande_scp.upande_scp.tests.test_auto_material_issue
```

- [ ] **Step 6: Commit**

```bash
git add upande_scp/serverscripts/spray_plan_creator/auto_material_issue.py upande_scp/hooks.py upande_scp/upande_scp/tests/test_auto_material_issue.py
git commit -m "feat(spray-plan): wire auto Material Issue handler + Stock Entry on_submit hook"
```

---

## Task 7: Atomic rollback test

Make sure a failure inside the chain (e.g., missing fallback account) rolls the entire transaction back — both the Manufacture submit and any partial Material Issue must not persist.

**Files:**
- Modify: `upande_scp/upande_scp/tests/test_auto_material_issue.py`

- [ ] **Step 1: Add the failing test**

Append:

```python
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
            "company": ctx["company"], "from_bom": 0,
            "work_order": ctx["wo"].name, "fg_completed_qty": 2,
            "to_warehouse": ctx["gh"],
            "items": [{
                "item_code": ctx["fg_item"], "is_finished_item": 1,
                "qty": 2, "uom": "Litre", "stock_uom": "Litre",
                "conversion_factor": 1, "t_warehouse": ctx["gh"],
                "basic_rate": 100, "allow_zero_valuation_rate": 1,
                "expense_account": ctx["expense_account"],
                "cost_center": ctx["cost_center"],
            }],
        })
        manu.flags.ignore_permissions = True
        manu.flags.ignore_links = True
        manu.insert()
        with self.assertRaises(frappe.ValidationError):
            manu.submit()

        # Manufacture must not be submitted (docstatus stays at 0 in the DB).
        self.assertEqual(
            frappe.db.get_value("Stock Entry", manu.name, "docstatus"),
            0,
            "Manufacture SE should not be submitted when auto-issue throws",
        )
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
```

- [ ] **Step 2: Run — expect PASS**

```bash
bench --site kaitet.local run-tests --app upande_scp --module upande_scp.upande_scp.tests.test_auto_material_issue
```

Expected: 16 passed total.

If the rollback test fails because Frappe commits the Manufacture submit before our `on_submit` hook runs, switch the handler's hook from `on_submit` to `before_submit` and re-run. (Frappe v15 runs custom `on_submit` doc-events *inside* the submit transaction, so this should not happen — but the test exists to catch the regression.)

- [ ] **Step 3: Commit**

```bash
git add upande_scp/upande_scp/tests/test_auto_material_issue.py
git commit -m "test(spray-plan): atomic rollback when auto-issue throws mid-chain"
```

---

## Task 8: Add `roles` to the server-rendered bootstrap

The frontend currently has no source of truth for the user's roles. Inline them into `window.SCP.bootstrap` from `scp_app.py`.

**Files:**
- Modify: `upande_scp/www/scp_app.py:77-89`
- Modify: `frontend/src/lib/frappe.ts:1-44`

- [ ] **Step 1: Extend `ScpBootstrap` on the frontend**

Edit `frontend/src/lib/frappe.ts`:

```ts
export interface ScpBootstrap {
  user: string;
  full_name: string;
  user_image: string;
  site_name: string;
  roles: string[];
}
```

And update the `bootstrap()` reader (currently lines 36-44) to:

```ts
export function bootstrap(): ScpBootstrap {
  const raw = window.SCP?.bootstrap || {};
  return {
    user: typeof raw.user === "string" ? raw.user : "",
    full_name: typeof raw.full_name === "string" ? raw.full_name : "",
    user_image: typeof raw.user_image === "string" ? raw.user_image : "",
    site_name: typeof raw.site_name === "string" ? raw.site_name : "",
    roles: Array.isArray(raw.roles) ? (raw.roles as string[]) : [],
  };
}
```

- [ ] **Step 2: Emit `roles` from the server**

Edit `upande_scp/www/scp_app.py` lines 77-89. Replace:

```python
	user_id = frappe.session.user
	user_doc = frappe.db.get_value(
		"User", user_id, ["full_name", "user_image"], as_dict=True
	) or {}
	context.bootstrap_json = json.dumps(
		{
			"user": user_id,
			"full_name": user_doc.get("full_name") or user_id,
			"user_image": user_doc.get("user_image") or "",
			"site_name": frappe.local.site,
		}
	)
```

with:

```python
	user_id = frappe.session.user
	user_doc = frappe.db.get_value(
		"User", user_id, ["full_name", "user_image"], as_dict=True
	) or {}
	user_roles = frappe.get_roles(user_id) or []
	context.bootstrap_json = json.dumps(
		{
			"user": user_id,
			"full_name": user_doc.get("full_name") or user_id,
			"user_image": user_doc.get("user_image") or "",
			"site_name": frappe.local.site,
			"roles": list(user_roles),
		}
	)
```

- [ ] **Step 3: Build the frontend**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp/www/scp_app.py frontend/src/lib/frappe.ts
git commit -m "feat(spray-plan): expose user roles in scp_app bootstrap"
```

---

## Task 9: Gate the Access Control sidebar item

Filter the `spray-plan-access` NAV item by required roles at render time. Other items are unaffected.

**Files:**
- Modify: `frontend/src/components/AppSidebar.tsx`
- Create: `frontend/src/components/__tests__/AppSidebar.test.tsx`

- [ ] **Step 1: Add a failing Vitest test**

Create `frontend/src/components/__tests__/AppSidebar.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";

function withRoles(roles: string[]): void {
  (window as unknown as { SCP?: Record<string, unknown> }).SCP = {
    bootstrap: { user: "u@example.com", roles },
  };
}

function clearRoles(): void {
  delete (window as unknown as { SCP?: unknown }).SCP;
}

function renderSidebar() {
  return render(
    <SidebarProvider>
      <AppSidebar view="dashboard" onNavigate={() => {}} />
    </SidebarProvider>,
  );
}

describe("AppSidebar role-gated items", () => {
  beforeEach(() => clearRoles());
  afterEach(() => clearRoles());

  it("hides Access Control for users without General Manager", () => {
    withRoles(["Spray Plan Creator"]);
    renderSidebar();
    expect(screen.queryByText("Access Control")).toBeNull();
  });

  it("shows Access Control for General Managers", () => {
    withRoles(["General Manager"]);
    renderSidebar();
    expect(screen.getByText("Access Control")).toBeInTheDocument();
  });

  it("shows Access Control for System Managers", () => {
    withRoles(["System Manager"]);
    renderSidebar();
    expect(screen.getByText("Access Control")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect FAIL (item is currently always rendered)**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npx vitest run src/components/__tests__/AppSidebar.test.tsx
```

Expected: "hides Access Control for users without General Manager" fails because the item is always rendered today.

- [ ] **Step 3: Add `requireRoles` to NavItem + filter at render**

Edit `frontend/src/components/AppSidebar.tsx`. Update the imports at the top (line 32) to also bring in `bootstrap`:

```tsx
import { viewHash, type View } from "@/lib/router";
import { bootstrap } from "@/lib/frappe";
```

Extend the `InAppItem` and `ExternalItem` types (lines 37-51) to support an optional `requireRoles`:

```tsx
type InAppItem = {
  kind: "view";
  view: View;
  label: string;
  icon: IconType;
  hint?: string;
  requireRoles?: string[];
};

type ExternalItem = {
  kind: "link";
  href: string;
  label: string;
  icon: IconType;
  hint?: string;
  requireRoles?: string[];
};
```

Add `requireRoles` to the Access Control entry (around line 93):

```tsx
      {
        kind: "view",
        view: "spray-plan-access",
        label: "Access Control",
        icon: ShieldCheck,
        requireRoles: ["General Manager", "System Manager"],
      },
```

Add a `userHasAnyRole` helper just above the `AppSidebar` function (around line 117):

```tsx
function userHasAnyRole(required: string[] | undefined, userRoles: string[]): boolean {
  if (!required || required.length === 0) return true;
  return required.some((r) => userRoles.includes(r));
}
```

In the `AppSidebar` body (around line 149-150), read roles from the bootstrap and filter each section's items before mapping:

```tsx
  const roles = bootstrap().roles || [];

  return (
    <Sidebar collapsible="icon">
      {/* ...unchanged header... */}
      <SidebarContent>
        {NAV.map((section) => {
          const visibleItems = section.items.filter((item) =>
            userHasAnyRole(item.requireRoles, roles),
          );
          if (visibleItems.length === 0) return null;
          return (
            <SidebarGroup key={section.label}>
              <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {visibleItems.map((item) => {
                    /* ...unchanged inner item-render code... */
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      {/* ...unchanged footer... */}
    </Sidebar>
  );
```

(Take care: only the outer mapping changes — the inner `SidebarMenuItem` rendering loop is identical to today's code, just over `visibleItems` instead of `section.items`.)

- [ ] **Step 4: Run — expect PASS (3 tests)**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npx vitest run src/components/__tests__/AppSidebar.test.tsx
```

- [ ] **Step 5: TypeScript check + production build**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Manual smoke**

Start the dev server and log in as a non-GM user (`stephene@upande.com` doesn't hold General Manager by default in test environments). Verify the "Access Control" sidebar entry is not visible. Log in as a GM and verify it is.

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npm run dev
```

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add frontend/src/components/AppSidebar.tsx frontend/src/components/__tests__/AppSidebar.test.tsx
git commit -m "feat(spray-plan): hide Access Control sidebar item from non-GMs"
```

---

## Task 10: End-to-end manual QA

This is the verification gate before merging. Open a freshly-restarted bench and walk the full chain.

- [ ] **Step 1: Restart bench so the new doc-event is loaded**

```bash
cd /home/ubuntu/stive/code/frappe15
bench restart
```

- [ ] **Step 2: Create a Part-A spray plan as a Spray Plan Creator**

Open `/scp_app#/application-plan`, add a draft with a Chemical Mix BOM that produces an FG item, and `Submit all for approval`.

- [ ] **Step 3: Approve it as the General Manager**

Open `/scp_app#/approvals`, find the WO, approve it. The existing flow creates a draft Material Transfer for Manufacture SE.

- [ ] **Step 4: Submit the Material Transfer for Manufacture SE**

In Desk → Stock Entry list, open the draft Material Transfer for Manufacture SE for the WO and submit it. The WO's `workflow_state` becomes `Chemical Issued`.

- [ ] **Step 5: Submit the Manufacture SE**

ERPNext lets the Work Order produce a Manufacture SE; submit it. Confirm:

- A new Material Issue SE for the same FG item appears in Stock Entry list, **already submitted** (docstatus = 1).
- The Material Issue's `from_warehouse` is the greenhouse warehouse.
- The Material Issue's row carries the Chemical Expense account (or whatever the Item Default specifies) and the correct cost center.
- The Material Issue's `custom_employee_data` table contains the Supervisor's Employee.
- The Work Order's `workflow_state` is `Completed`.
- A `Workflow` comment on the WO records the auto Material Issue's name.

- [ ] **Step 6: Negative-path smoke**

Unset both the Item Default expense account for your FG item AND `Spray Plan Settings.default_chemical_expense_account`. Try the chain again. The Manufacture SE submit must fail with a clear "Cannot auto-issue tank-mix..." message, and the Manufacture SE must remain a draft.

- [ ] **Step 7: Sidebar smoke (non-GM)**

Log in as a user who only holds `Spray Plan Creator`. Open `/scp_app`. Verify the "Access Control" item is not in the sidebar. Log out, log back in as a GM, verify it is.

---

## Plan Self-Review

**Spec coverage check:**

- §1 goals: covered by tasks 1–9.
- §2 non-goals: untouched.
- §3 trigger/transaction: tasks 2 (no-op gating), 6 (real handler + hook registration), 7 (rollback test).
- §4.1 supervisor: task 3.
- §4.2 expense account: tasks 1 (settings field) and 4 (resolver).
- §4.3 cost center / farm: task 5 (`build_material_issue` reads `WO.custom_cost_center` and the greenhouse's `custom_farm`).
- §4.4 MI dict: task 5.
- §5 schema additions: task 1.
- §6 workflow state map: task 6 (sets `Completed`).
- §7 sidebar gating: tasks 8 + 9.
- §8 edge cases: tasks 3 (no supervisor + no user-employee → throw), 4 (missing accounts → throw), 5 (no FG row, no farm, no cost center → throw), 7 (atomic rollback).
- §9 testing: tasks 2/3/4/5/6/7 (backend pytest) + task 9 (frontend Vitest).

No gaps.

**Type consistency check:**

- `resolve_supervisor_employee(wo) -> str` — used in `on_manufacture_submit` (task 6) and tested directly (task 3).
- `resolve_expense_account(item_code, company) -> str` — called from `build_material_issue` (task 5).
- `build_material_issue(manufacture_se, wo, supervisor_employee)` — called from `on_manufacture_submit` (task 6).
- `userHasAnyRole(required, userRoles)` — used inside `AppSidebar` body (task 9).
- `ScpBootstrap.roles: string[]` — defined in task 8, read in task 9.

All signatures match across tasks.

**Placeholder scan:** none. Each step ships either complete code or an exact command + expected output.

---

## Execution Notes

- Bench site path assumes the local kaitet site at `kaitet.local`; substitute as needed.
- The integration tests deliberately skip the real BOM/Manufacture flow because it requires a full BOM scaffold. The handler only reads from the Stock Entry / Work Order doc — bypassing the BOM doesn't affect coverage of *this* code path.
- If `bench --site kaitet.local run-tests` doesn't pick up the new module, ensure `upande_scp/upande_scp/tests/__init__.py` exists (it does today).
- If the doc-event fires *outside* the submit transaction (Frappe versions vary), task 7 will catch it and the handler should be switched from `on_submit` to `before_submit` per task 7 step 2's note.
