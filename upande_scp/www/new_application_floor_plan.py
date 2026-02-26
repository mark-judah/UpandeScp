import frappe

def get_context(context):
    context.no_cache = 1
    csrf_token = frappe.sessions.get_csrf_token()
    context.csrf_token = csrf_token
    
    warehouses = frappe.db.get_list(
        "Warehouse",
        filters={"warehouse_type": "Greenhouse"},
        fields=["name", "custom_farm"]
    )
    context.warehouses_list = warehouses

    # Fetch spray equipment and its child rows
    spray_equipment = frappe.get_all(
        "Spray Equipment Details",
        fields=["kit", "warehouse"],
        order_by="idx ASC"
    )
    context.spray_equipment_list = spray_equipment

    return context