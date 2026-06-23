import frappe

no_cache = 1


def get_context(context):
    if frappe.session.user == "Guest":
        frappe.throw("Please log in to view the scouting reports page.", frappe.PermissionError)
    context.no_cache = 1
    context.title = "Scouting Reports"
    context.csrf_token = frappe.sessions.get_csrf_token()
    return context
