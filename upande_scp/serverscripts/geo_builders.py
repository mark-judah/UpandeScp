"""Warehouse / geo builders used by the React SCP app.

These helpers were formerly private functions inside the desk www pages
(``www/new_application_floor_plan/index.py`` and
``www/avocado_scouts_map/index.py``). They are relocated here so the React
app's API layer (``scouting_metrics_api``) no longer imports anything from
``upande_scp.www.*`` — keeping the React app fully independent of the
(now-retired) desk www pages.
"""

import json

import frappe

from upande_scp.serverscripts.warehouse_filter import (
    gh_sort_key,
    is_greenhouse_allowed,
    load_settings,
)


def build_afp_warehouses():
    """Greenhouse warehouses in Application-Floor-Plan scope.

    Uses Spray Plan Settings allowed_farms + the GH-name regex + exclude
    keywords, so the React greenhouse list matches the legacy JS one.
    Cost-center resolution stays lazy (see resolve_warehouse_cost_center).
    """
    allowed, exclude = load_settings()
    allowed_lower = tuple(f.lower() for f in allowed)
    if not allowed_lower:
        return []
    warehouses = frappe.get_all(
        "Warehouse",
        filters={"warehouse_type": "Greenhouse"},
        fields=["name", "custom_farm", "custom_cost_center"],
        limit_page_length=0,
    )
    filtered = [
        wh
        for wh in warehouses
        if is_greenhouse_allowed(
            wh.get("name") or "",
            allowed_lower,
            exclude,
            has_farm=bool(wh.get("custom_farm")),
        )
    ]
    filtered.sort(
        key=lambda wh: gh_sort_key(wh.get("name") or "", allowed_lower),
    )
    return filtered


def build_blocks_geojson():
    """Parse ``custom_raw_geojson`` from every Block warehouse, once.

    Each feature already carries ``block``, ``block_code``, ``tree_count``,
    ``area_m2``, etc. — we just inject the human label so tooltips can show
    ``warehouse_name`` instead of the dashed warehouse ``name``.
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
