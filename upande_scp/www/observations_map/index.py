import frappe


def get_context(context):
    context.no_cache = 1
    map_settings = frappe.get_doc("Map Settings", "Map Settings")

    context.lat = map_settings.lat
    context.lon = map_settings.lon
    context.default_zoom = map_settings.default_zoom
    context.csrf_token = frappe.sessions.get_csrf_token()

    gh_warehouses = frappe.get_all(
        "Warehouse",
        filters={"warehouse_type": "Greenhouse", "disabled": 0},
        fields=["name", "warehouse_name"],
        order_by="name",
    )
    context.greenhouses_geojson = [
        {"name": wh["name"], "short_name": wh["warehouse_name"]}
        for wh in gh_warehouses
    ]
    return context
