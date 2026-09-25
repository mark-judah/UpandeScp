import frappe
from upande_scp.serverscripts.roles import has_any_role


def get_context(context):
    context.no_cache = 1
    context.title = "Spray Plan Approval"

    if not frappe.session.user or frappe.session.user == "Guest":
        frappe.throw("Please log in to access this page.", frappe.PermissionError)

    if not has_any_role("Spray Plan Approver", "General Manager"):
        frappe.throw(
            "This page requires the General Manager or Spray Plan Approver role.",
            frappe.PermissionError,
        )

    context.csrf_token = frappe.sessions.get_csrf_token()
    frappe.db.commit()
