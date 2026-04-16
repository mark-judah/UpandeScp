import frappe


def get_context(context):
    context.no_cache = 1
    context.title = "Spray Plan Approval"

    if not frappe.session.user or frappe.session.user == "Guest":
        frappe.throw("Please log in to access this page.", frappe.PermissionError)

    roles = frappe.get_roles(frappe.session.user)
    if "General Manager" not in roles and "System Manager" not in roles:
        frappe.throw(
            "This page requires General Manager access.",
            frappe.PermissionError,
        )

    context.csrf_token = frappe.sessions.get_csrf_token()
    frappe.db.commit()
