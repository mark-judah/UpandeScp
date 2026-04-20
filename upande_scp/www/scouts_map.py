import json
import frappe

from upande_scp.serverscripts.cache_utils import (
    K_GREENHOUSES_GEOJSON,
    TTL_LONG,
    get_or_set,
)


def _build_greenhouses_geojson():
    """Parse once, cache forever (until Warehouse update invalidates)."""
    gh_warehouses = frappe.get_all(
        "Warehouse",
        filters={"warehouse_type": "Greenhouse", "disabled": 0},
        fields=["name", "warehouse_name", "custom_raw_geojson"],
        order_by="name",
        limit_page_length=0,
    )

    greenhouses = []
    for wh in gh_warehouses:
        raw = wh.get("custom_raw_geojson") or "{}"
        try:
            geojson = json.loads(raw)
        except json.JSONDecodeError as e:
            frappe.log_error(
                title=f"Invalid GeoJSON in {wh['name']}",
                message=f"{e}\nRaw: {raw[:200]}...",
            )
            continue
        if not isinstance(geojson, dict) or not geojson.get("features"):
            continue
        greenhouses.append({
            "name": wh["name"],
            "short_name": wh["warehouse_name"],
            "geojson": geojson,
        })

    return greenhouses


def get_context(context):
    context.no_cache = 1
    map_settings = frappe.get_doc("Map Settings", "Map Settings")

    context.lat = map_settings.lat
    context.lon = map_settings.lon
    context.default_zoom = map_settings.default_zoom
    context.csrf_token = frappe.sessions.get_csrf_token()

    context.greenhouses_geojson = get_or_set(
        K_GREENHOUSES_GEOJSON, _build_greenhouses_geojson, ttl=TTL_LONG
    )
    return context
