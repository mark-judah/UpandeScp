"""Avocado-only 3D orchard scouting map.

Renders a MapLibre + Three.js page with one InstancedMesh per block of
avocado trees. Trees recolor per-scout based on the day's Scouting Entries.
"""

import json

import frappe

from upande_scp.serverscripts.cache_utils import (
    K_BLOCKS_GEOJSON,
    K_FARM_HIERARCHY,
    TTL_LONG,
    get_or_set,
)
from upande_scp.www.scouts_map import _build_farm_hierarchy


def _build_blocks_geojson():
    """Parse `custom_raw_geojson` from every Block warehouse, once.

    Each feature already carries `block`, `block_code`, `tree_count`,
    `area_m2`, etc. — we just inject the human label so tooltips can show
    `warehouse_name` instead of the dashed warehouse `name`.
    """
    block_warehouses = frappe.get_all(
        "Warehouse",
        filters={"warehouse_type": "Block", "disabled": 0},
        fields=[
            "name", "warehouse_name", "custom_farm",
            "parent_warehouse", "custom_raw_geojson",
        ],
        order_by="name",
        limit_page_length=0,
    )

    features = []
    for wh in block_warehouses:
        raw = wh.get("custom_raw_geojson") or ""
        if not raw:
            continue
        try:
            geo = json.loads(raw)
        except (TypeError, ValueError) as e:
            frappe.log_error(
                title=f"Invalid GeoJSON in {wh['name']}",
                message=f"{e}\nRaw: {raw[:200]}...",
            )
            continue
        feats = geo.get("features") if isinstance(geo, dict) else None
        if not feats:
            continue
        for f in feats:
            if not isinstance(f, dict) or not f.get("geometry"):
                continue
            props = dict(f.get("properties") or {})
            props["block"] = wh["name"]
            props["block_label"] = wh.get("warehouse_name") or wh["name"]
            props["farm"] = wh.get("custom_farm") or ""
            features.append({
                "type": "Feature",
                "geometry": f["geometry"],
                "properties": props,
            })

    return {"type": "FeatureCollection", "features": features}


def get_context(context):
    context.no_cache = 1
    map_settings = frappe.get_doc("Map Settings", "Map Settings")

    context.lat = map_settings.lat
    context.lon = map_settings.lon
    context.default_zoom = map_settings.default_zoom
    context.csrf_token = frappe.sessions.get_csrf_token()

    context.blocks_geojson = get_or_set(
        K_BLOCKS_GEOJSON, _build_blocks_geojson, ttl=TTL_LONG
    )
    context.farm_hierarchy = get_or_set(
        K_FARM_HIERARCHY, _build_farm_hierarchy, ttl=TTL_LONG
    )
    return context
