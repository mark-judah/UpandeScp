"""Create the Spray Plan Creator role.

Idempotent. Run once during `bench migrate`.
"""
import frappe


def execute() -> None:
    if frappe.db.exists("Role", "Spray Plan Creator"):
        return
    frappe.get_doc({
        "doctype": "Role",
        "role_name": "Spray Plan Creator",
        "desk_access": 0,
        "is_custom": 1,
    }).insert(ignore_permissions=True)
    frappe.db.commit()
