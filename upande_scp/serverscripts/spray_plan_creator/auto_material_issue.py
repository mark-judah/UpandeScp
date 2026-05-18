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
