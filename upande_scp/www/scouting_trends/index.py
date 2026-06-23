import frappe

no_cache = 1


def get_context(context):
    if frappe.session.user == "Guest":
        frappe.throw("Please log in to view the scouting trends page.", frappe.PermissionError)
    context.no_cache = 1
    context.title = "Scouting Trends"
    context.csrf_token = frappe.sessions.get_csrf_token()
    return context
