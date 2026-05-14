import frappe


def get_context(context):
    context.no_cache = 1
    context.title = "Spray Plan Approval"

    if not frappe.session.user or frappe.session.user == "Guest":
        frappe.throw("Please log in to access this page.", frappe.PermissionError)

    roles = set(frappe.get_roles(frappe.session.user))
    allowed = {"Spray Plan Approver", "General Manager", "System Manager"}
    if not roles.intersection(allowed):
        frappe.throw(
            "This page requires the Spray Plan Approver role.",
            frappe.PermissionError,
        )

    context.csrf_token = frappe.sessions.get_csrf_token()
    frappe.db.commit()
