import frappe
import json

def get_context(context):
    context.csrf_token = frappe.sessions.get_csrf_token()
    gh_warehouses = frappe.get_all(
        "Warehouse",
        filters={"warehouse_type": "Greenhouse", "disabled": 0},
        fields=["name", "warehouse_name", "custom_raw_geojson"],
        order_by="name"
    )

    greenhouses = []
    for wh in gh_warehouses:
        raw = wh.get("custom_raw_geojson") or "{}"
        try:
            geojson = json.loads(raw)
            if not isinstance(geojson, dict) or not geojson.get("features"):
                continue
            greenhouses.append({
                "name": wh["name"],
                "short_name": wh["warehouse_name"],
                "geojson": geojson
            })
        except json.JSONDecodeError as e:
            
            frappe.log_error(
                title=f"Invalid GeoJSON in {wh['name']}",
                message=f"{e}\nRaw: {raw[:200]}..."
            )
            continue
        except Exception as e:
            frappe.log_error(
                title=f"Error processing warehouse {wh['name']}",
                message=str(e)
            )
            continue

    context.greenhouses_geojson = greenhouses
    return context