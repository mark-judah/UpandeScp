"""Spray Plan Creator page bootstrap endpoint."""
from __future__ import annotations

import frappe

from .scope import _resolve_user_scope


@frappe.whitelist()
def fetch_creator_bootstrap() -> dict:
    user = frappe.session.user
    scope = _resolve_user_scope(user)

    if not scope["farms"]:
        return _empty_bootstrap()

    farms = scope["farms"]
    warehouse_names = [w["name"] for w in scope["warehouses"]]

    greenhouses = _enrich_greenhouses(scope["greenhouses"])

    # Kits live in `Spray Equipment Details` (child table), NOT `Spray Kit` (which doesn't exist here).
    kits = []
    if frappe.db.table_exists("Spray Equipment Details") and warehouse_names:
        kits = frappe.get_all(
            "Spray Equipment Details",
            filters={"warehouse": ["in", warehouse_names]},
            fields=["kit", "warehouse"],
        )
        for k in kits:
            k["custom_farm"] = frappe.db.get_value("Warehouse", k["warehouse"], "custom_farm")

    spray_teams = frappe.get_all(
        "Spray Team",
        filters={"custom_farm": ["in", farms], "enabled": 1},
        fields=["name", "custom_farm"],
    )
    for t in spray_teams:
        t["members"] = frappe.get_all(
            "Spray Team Details",
            filters={"parent": t["name"]},
            fields=["name1 as employee", "role"],
        )

    bom_filters = {
        "custom_item_group": "Chemical Mix",
        "is_active": 1,
        "docstatus": 1,
    }
    if frappe.db.has_column("BOM", "custom_farm"):
        bom_filters["custom_farm"] = ["in", farms]
    tank_mixes = frappe.get_all(
        "BOM",
        filters=bom_filters,
        fields=["name", "item_name"] + (["custom_farm"] if frappe.db.has_column("BOM", "custom_farm") else []),
        order_by="modified desc",
    )

    rate_limits = _fetch_rate_limits()

    pest_catalog = frappe.get_all("Pest", fields=["name"], order_by="name") \
        if frappe.db.table_exists("Pest") else []
    # Disease catalog is `Plant Disease`, not `Disease`.
    disease_catalog = frappe.get_all("Plant Disease", fields=["name"], order_by="name") \
        if frappe.db.table_exists("Plant Disease") else []

    settings = frappe.get_single("Spray Plan Settings")
    return {
        "scope": {"farms": farms, "allowed_warehouses": scope["warehouses"]},
        "greenhouses": greenhouses,
        "kits": kits,
        "spray_teams": spray_teams,
        "tank_mixes": tank_mixes,
        "rate_limits": rate_limits,
        "pest_catalog": pest_catalog,
        "disease_catalog": disease_catalog,
        "weather_settings": {
            "wind_green_max_kmh": settings.weather_wind_green_max_kmh,
            "wind_red_min_kmh":   settings.weather_wind_red_min_kmh,
            "rain_green_max_pct": settings.weather_rain_green_max_pct,
            "rain_red_min_pct":   settings.weather_rain_red_min_pct,
            "temp_green_min_c":   settings.weather_temp_green_min_c,
            "temp_green_max_c":   settings.weather_temp_green_max_c,
            "temp_red_max_c":     settings.weather_temp_red_max_c,
            "temp_red_min_c":     settings.weather_temp_red_min_c,
        },
        "irac_window_days": settings.irac_rotation_window_days or 14,
        "frac_window_days": settings.frac_rotation_window_days or 21,
    }


def _empty_bootstrap() -> dict:
    return {
        "scope": {"farms": [], "allowed_warehouses": []},
        "greenhouses": [], "kits": [], "spray_teams": [], "tank_mixes": [],
        "rate_limits": {}, "pest_catalog": [], "disease_catalog": [],
        "weather_settings": {}, "irac_window_days": 14, "frac_window_days": 21,
    }


def _fetch_rate_limits() -> dict:
    """Build {item_code: {lower, upper}} from Item custom fields."""
    rows = frappe.db.sql(
        """SELECT name AS item_code, custom_lower_rate_limit, custom_upper_rate_limit
           FROM `tabItem`
           WHERE (custom_lower_rate_limit IS NOT NULL AND custom_lower_rate_limit > 0)
              OR (custom_upper_rate_limit IS NOT NULL AND custom_upper_rate_limit > 0)""",
        as_dict=True,
    )
    return {
        r["item_code"]: {
            "lower": r["custom_lower_rate_limit"] or None,
            "upper": r["custom_upper_rate_limit"] or None,
        }
        for r in rows
    }


def _enrich_greenhouses(greenhouses: list[dict]) -> list[dict]:
    """Attach latitude/longitude from Map Settings.farm_coordinates if present.

    Falls back to None when no coords are configured for a farm so the weather
    feature can degrade gracefully without blocking the page.
    """
    out: list[dict] = []
    has_coords = frappe.db.table_exists("Farm Map Coordinate")
    for gh in greenhouses:
        record = {
            "name": gh["name"],
            "custom_farm": gh.get("custom_farm"),
            "latitude": None,
            "longitude": None,
        }
        if has_coords and gh.get("custom_farm"):
            row = frappe.db.get_value(
                "Farm Map Coordinate",
                {"parent": "Map Settings", "farm": gh["custom_farm"]},
                ["lat", "lon"],
                as_dict=True,
            )
            if row:
                record["latitude"] = row.get("lat")
                record["longitude"] = row.get("lon")
        out.append(record)
    return out
