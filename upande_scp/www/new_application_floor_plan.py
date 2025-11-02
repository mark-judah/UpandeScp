import frappe

def get_context(context):
    csrf_token = frappe.sessions.get_csrf_token()
    context.csrf_token = csrf_token
    warehouses = frappe.db.get_list(
        "Warehouse",
        filters={
            "warehouse_type": "Greenhouse"
        },
        fields=["name"]
    )

    context.warehouses_list = warehouses
    return context