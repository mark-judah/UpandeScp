"""Spray Plan Creator page bootstrap endpoint."""
from __future__ import annotations

import frappe

from upande_scp.serverscripts.warehouse_filter import (
    is_greenhouse_allowed,
    load_settings,
)

from .scope import _resolve_user_scope
from .validation import match_cost_center


@frappe.whitelist()
def fetch_creator_bootstrap() -> dict:
    user = frappe.session.user
    scope = _resolve_user_scope(user)

    if not scope["farms"]:
        return _empty_bootstrap()

    farms = scope["farms"]
    warehouse_names = [w["name"] for w in scope["warehouses"]]

    # Apply the Spray Plan Settings exclude-keyword filter on top of the
    # farm-scoped greenhouses so CSU / IPM / phase / tunnel rooms don't
    # appear in the picker. The "allowed farms" check is folded in below
    # by overriding with the user's actual farm scope.
    _, exclude_lower = load_settings()
    farms_lower = tuple((f or "").lower() for f in farms)
    filtered_ghs = [
        gh for gh in scope["greenhouses"]
        if is_greenhouse_allowed(
            gh["name"], farms_lower, exclude_lower,
            has_farm=bool(gh.get("custom_farm")),
        )
    ]
    greenhouses = _enrich_greenhouses(filtered_ghs)

    # Kits live in `Spray Equipment Details` (child table), NOT `Spray Kit` (which doesn't exist here).
    # The source data has literal duplicate rows (same kit + same warehouse repeated 3x), so we
    # deduplicate by (kit, warehouse) tuple before returning.
    kits = []
    if frappe.db.table_exists("Spray Equipment Details") and warehouse_names:
        rows = frappe.get_all(
            "Spray Equipment Details",
            filters={"warehouse": ["in", warehouse_names]},
            fields=["kit", "warehouse"],
        )
        seen: set[tuple[str, str]] = set()
        for r in rows:
            key = (r.get("kit") or "", r.get("warehouse") or "")
            if key in seen or not key[0]:
                continue
            seen.add(key)
            r["custom_farm"] = frappe.db.get_value("Warehouse", r["warehouse"], "custom_farm")
            kits.append(r)

    # Spray teams are matched by farm-name substring on the team_name —
    # custom_farm is unreliable (not all teams have it populated; the
    # backfill only covered teams with a clean WO history). Convention
    # at Upande is to prefix the team name with the farm (e.g.
    # "CHEPSITO CSU 1" belongs to the "Chepsito" farm).
    spray_teams = []
    if farms:
        name_clauses = " OR ".join(["LOWER(name) LIKE %s"] * len(farms))
        like_params = [f"%{(f or '').lower()}%" for f in farms]
        rows = frappe.db.sql(
            f"""SELECT name, custom_farm FROM `tabSpray Team`
                WHERE enabled = 1 AND ({name_clauses})""",
            like_params,
            as_dict=True,
        )
        # De-dupe in case a team name matches multiple allowed farms.
        seen = set()
        for row in rows:
            if row["name"] in seen:
                continue
            seen.add(row["name"])
            spray_teams.append(row)
    for t in spray_teams:
        # JOIN onto Employee so the picker can show real names alongside the
        # Employee ID (== payroll number). Coalesce avoids dropping rows when
        # the Employee row was renamed or deleted out from under the team.
        t["members"] = frappe.db.sql(
            """SELECT std.name1 AS employee,
                      COALESCE(emp.employee_name, std.name1) AS employee_name,
                      emp.designation AS designation,
                      std.role AS role
                 FROM `tabSpray Team Details` std
                 LEFT JOIN `tabEmployee` emp ON emp.name = std.name1
                WHERE std.parent = %s
                ORDER BY std.idx""",
            (t["name"],),
            as_dict=True,
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
    # Active, non-group Cost Centers — drives the override picker on the
    # ApplicationPlan page. Returns all companies so the picker can show
    # cross-company options when the operator overrides intentionally.
    cost_centers = frappe.get_all(
        "Cost Center",
        filters={"disabled": 0, "is_group": 0},
        fields=["name", "company", "custom_farm"],
        order_by="name asc",
    )

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
        "cost_centers": cost_centers,
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
        "cost_centers": [],
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
            "cost_center": match_cost_center(gh["name"]),
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
