"""Lightweight factories for the Spray Plan A1 test suite.

All factories accept ``frappe`` as an implicit dependency and return doc-like
records or raw names. They use ``ignore_permissions=True`` so tests don't
need to switch users mid-test.
"""
from __future__ import annotations

import frappe


def ensure_role(name: str) -> None:
    if not frappe.db.exists("Role", name):
        frappe.get_doc({"doctype": "Role", "role_name": name}).insert(ignore_permissions=True)


def ensure_user(email: str, roles: list[str] | None = None, full_name: str = "") -> str:
    if not frappe.db.exists("User", email):
        u = frappe.get_doc({
            "doctype": "User", "email": email, "first_name": full_name or email,
            "send_welcome_email": 0, "enabled": 1,
        })
        u.insert(ignore_permissions=True)
    # Roles are additive: this factory never removes roles already on the user.
    if roles:
        for r in roles:
            ensure_role(r)
            if not frappe.db.exists("Has Role", {"parent": email, "role": r}):
                frappe.get_doc({
                    "doctype": "Has Role", "parent": email, "parenttype": "User",
                    "parentfield": "roles", "role": r,
                }).insert(ignore_permissions=True)
    return email


def ensure_farm(name: str) -> str:
    if not frappe.db.exists("Farm", name):
        frappe.get_doc({"doctype": "Farm", "farm": name}).insert(ignore_permissions=True)
    return name


def assign_creator(user: str, farms: list[str]) -> None:
    for farm in farms:
        ensure_farm(farm)
        doc = frappe.get_doc("Farm", farm)
        already = {row.user for row in (doc.spray_plan_creators or [])}
        if user in already:
            continue
        doc.append("spray_plan_creators", {"user": user})
        doc.save(ignore_permissions=True)


def cleanup_user(email: str) -> None:
    if frappe.db.exists("User", email):
        frappe.delete_doc("User", email, force=1, ignore_permissions=True)
