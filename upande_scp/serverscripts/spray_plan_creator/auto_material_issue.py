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
from frappe.utils import now_datetime

AFP_TYPE = "Application Floor Plan"


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

    _emp_candidate_fields = ["employee_name", "department", "location"]
    _emp_meta_obj = frappe.get_meta("Employee")
    _emp_fields = [f for f in _emp_candidate_fields if _emp_meta_obj.get_field(f)]
    emp_meta = (
        frappe.db.get_value("Employee", supervisor_employee, _emp_fields, as_dict=True)
        if _emp_fields else {}
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
