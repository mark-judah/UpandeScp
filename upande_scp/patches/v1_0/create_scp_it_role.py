"""Create the SCP IT role (opens the IT monitor and reads the SCP Mobile doctypes).

Idempotent.
"""
import frappe


def execute() -> None:
    if frappe.db.exists("Role", "SCP IT"):
        return
    frappe.get_doc({
        "doctype": "Role",
        "role_name": "SCP IT",
        "desk_access": 1,
        "is_custom": 1,
    }).insert(ignore_permissions=True)
