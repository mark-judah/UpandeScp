import frappe

def get_context(context):
    context.no_cache = 1     
    csrf_token = frappe.sessions.get_csrf_token()
    context.csrf_token = csrf_token
    context.title = "Scouting Heatmap - All Greenhouses"
    frappe.db.commit()