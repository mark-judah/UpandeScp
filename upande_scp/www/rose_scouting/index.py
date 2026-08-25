"""Rose-only scouting map (renamed from scouts_map).

The page filters scouting entries to crop_scouted in ('', 'Rose'/'Roses').
"""

import json
import frappe

from upande_scp.serverscripts.common.cache_utils import (
    K_FARM_HIERARCHY,
    K_GREENHOUSES_GEOJSON,
    TTL_LONG,
    get_or_set,
)


def _build_farm_hierarchy():
    """Build a Farm → Section → Block/Greenhouse cascade.

    Sections are optional: when a block sits directly under a Farm-type
    warehouse, it is bucketed under section name `""` so the client can show
    it under "(No section)".
    """
    leaves = frappe.get_all(
        "Warehouse",
        filters={
            "warehouse_type": ["in", ["Block", "Greenhouse"]],
            "disabled": 0,
            "is_group": 0,
        },
        fields=["name", "warehouse_name", "warehouse_type", "parent_warehouse", "custom_farm"],
        order_by="warehouse_name",
        limit_page_length=0,
    )

    parent_names = {l["parent_warehouse"] for l in leaves if l.get("parent_warehouse")}
    parents = frappe.get_all(
        "Warehouse",
        filters={"name": ["in", list(parent_names)]} if parent_names else {"name": ""},
        fields=["name", "warehouse_name", "warehouse_type"],
        limit_page_length=0,
    )
    parent_by_name = {p["name"]: p for p in parents}

    farms = {}
    for leaf in leaves:
        farm = leaf.get("custom_farm") or "(Unassigned)"
        parent = parent_by_name.get(leaf.get("parent_warehouse") or "", {})
        is_section = parent.get("warehouse_type") == "Section"
        section_name = parent["name"] if is_section else ""
        section_label = parent.get("warehouse_name") if is_section else "(No section)"

        farm_bucket = farms.setdefault(farm, {"name": farm, "sections": {}})
        section_bucket = farm_bucket["sections"].setdefault(
            section_name, {"name": section_name, "label": section_label, "blocks": []}
        )
        section_bucket["blocks"].append(
            {
                "name": leaf["name"],
                "label": leaf.get("warehouse_name") or leaf["name"],
                "type": leaf.get("warehouse_type"),
            }
        )

    out = []
    for farm in sorted(farms.values(), key=lambda f: f["name"].lower()):
        sections = sorted(
            farm["sections"].values(),
            key=lambda s: (s["name"] == "", s["label"].lower()),
        )
        out.append({"name": farm["name"], "sections": sections})
    return out


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


def _build_farm_coordinates(map_settings):
    """Map of farm name → {lat, lon, zoom} from Map Settings child table."""
    out = {}
    for row in (map_settings.get("farm_coordinates") or []):
        farm = (row.farm or "").strip()
        if not farm or row.lat in (None, 0) or row.lon in (None, 0):
            continue
        out[farm] = {
            "lat": row.lat,
            "lon": row.lon,
            "zoom": row.default_zoom or map_settings.default_zoom,
        }
    return out


def get_context(context):
    context.no_cache = 1
    map_settings = frappe.get_doc("Map Settings", "Map Settings")

    context.lat = map_settings.lat
    context.lon = map_settings.lon
    context.default_zoom = map_settings.default_zoom
    context.farm_coordinates = _build_farm_coordinates(map_settings)
    context.csrf_token = frappe.sessions.get_csrf_token()

    context.greenhouses_geojson = get_or_set(
        K_GREENHOUSES_GEOJSON, _build_greenhouses_geojson, ttl=TTL_LONG
    )
    context.farm_hierarchy = get_or_set(
        K_FARM_HIERARCHY, _build_farm_hierarchy, ttl=TTL_LONG
    )
    return context
