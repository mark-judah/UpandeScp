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
    # A kit's warehouse (the destination CSU) is in scope when it belongs to one of the user's farms
    # OR is untagged (NULL/blank custom_farm = global) — the same convention chemical stores and spray
    # teams use. mona's CSUs ("Main CSU A - MFK") carry no custom_farm, so the old strict
    # ``warehouse IN <farm-scoped>`` filter dropped every kit; CSUs tagged to a *different* farm stay
    # hidden. The source data has literal duplicate rows (same kit + same warehouse repeated 3x), so we
    # deduplicate by (kit, warehouse) tuple before returning.
    kits = []
    if frappe.db.table_exists("Spray Equipment Details"):
        rows = frappe.get_all(
            "Spray Equipment Details",
            fields=["kit", "warehouse"],
        )
        farms_set = set(farms)
        seen: set[tuple[str, str]] = set()
        wh_cache: dict[str, dict | None] = {}
        for r in rows:
            key = (r.get("kit") or "", r.get("warehouse") or "")
            if not key[0] or not key[1] or key in seen:
                continue
            wh = key[1]
            if wh not in wh_cache:
                wh_cache[wh] = frappe.db.get_value(
                    "Warehouse", wh, ["custom_farm", "disabled"], as_dict=True
                )
            info = wh_cache[wh]
            if not info or info.get("disabled"):
                continue
            farm = info.get("custom_farm")
            # NULL/blank farm = global; otherwise it must be one of the user's farms.
            if farm and farm not in farms_set:
                continue
            seen.add(key)
            kits.append({"kit": key[0], "warehouse": wh, "custom_farm": farm})

    spray_teams = _fetch_spray_teams(farms)

    # BOMs are NOT farm-scoped in the picker. The www form has always
    # shown every active Chemical Mix BOM regardless of farm, so the
    # React creator does the same — the operator can pick any BOM and
    # the per-row chemical-warehouse selector handles the actual
    # source restriction farm-side.
    bom_filters = {
        "custom_item_group": "Chemical Mix",
        "is_active": 1,
        "docstatus": 1,
    }
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


def _fetch_spray_teams(farms: list) -> list:
    """Spray teams visible to a user whose allowed farms are ``farms``.

    A team matches when its ``custom_farm`` is one of the allowed farms, OR it
    has no ``custom_farm`` set (treated as global/unscoped), OR — legacy
    convention — an allowed farm name appears in the team name (e.g.
    "CHEPSITO CSU 1" belongs to the "Chepsito" farm). Older code matched ONLY
    by name substring, which silently dropped farm-tagged teams whose name
    didn't contain the farm (e.g. mona's "Team A" on farm "Main"). The
    frontend narrows further to the *selected greenhouse's* farm; this returns
    the full candidate set so farm-tagged and unfarmed teams both reach it.
    Each team carries its members joined from Employee.
    """
    if not farms:
        return []

    params: dict = {"farms": tuple(farms)}
    name_parts = []
    for i, f in enumerate(farms):
        key = f"name{i}"
        name_parts.append(f"LOWER(name) LIKE %({key})s")
        params[key] = f"%{(f or '').lower()}%"
    where = " OR ".join(
        ["custom_farm IN %(farms)s", "custom_farm IS NULL", "custom_farm = ''"]
        + name_parts
    )
    rows = frappe.db.sql(
        f"""SELECT name, custom_farm FROM `tabSpray Team`
            WHERE enabled = 1 AND ({where})
            ORDER BY name""",
        params,
        as_dict=True,
    )

    spray_teams = []
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
    return spray_teams


def _empty_bootstrap() -> dict:
    return {
        "scope": {"farms": [], "allowed_warehouses": []},
        "greenhouses": [], "kits": [], "spray_teams": [], "tank_mixes": [],
        "rate_limits": {}, "pest_catalog": [], "disease_catalog": [],
        "cost_centers": [],
        "weather_settings": {}, "irac_window_days": 14, "frac_window_days": 21,
    }


def _fetch_rate_limits() -> dict:
    """Build {item_code: {lower, upper}} from the Chemical master, falling back
    to Item custom fields for any chemical without a Chemical row yet."""
    out: dict = {}
    for r in frappe.db.sql(
        """SELECT item AS item_code, lower_rate_limit, upper_rate_limit
           FROM `tabChemical`
           WHERE (lower_rate_limit IS NOT NULL AND lower_rate_limit > 0)
              OR (upper_rate_limit IS NOT NULL AND upper_rate_limit > 0)""",
        as_dict=True,
    ):
        out[r["item_code"]] = {
            "lower": r["lower_rate_limit"] or None,
            "upper": r["upper_rate_limit"] or None,
        }
    for r in frappe.db.sql(
        """SELECT i.name AS item_code, i.custom_lower_rate_limit, i.custom_upper_rate_limit
           FROM `tabItem` i
           WHERE NOT EXISTS (SELECT 1 FROM `tabChemical` c WHERE c.item = i.name)
             AND ((i.custom_lower_rate_limit IS NOT NULL AND i.custom_lower_rate_limit > 0)
               OR (i.custom_upper_rate_limit IS NOT NULL AND i.custom_upper_rate_limit > 0))""",
        as_dict=True,
    ):
        out.setdefault(r["item_code"], {
            "lower": r["custom_lower_rate_limit"] or None,
            "upper": r["custom_upper_rate_limit"] or None,
        })
    return out


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
