"""Whitelisted endpoints for the unified Spray Plan Settings page.

The page consolidates four areas that were previously edited in Frappe
Desk only:

  1. Spray Plan Settings (the Single doctype) — IRAC/FRAC windows, weather
     thresholds, default expense account, allowed farms, exclude keywords.
  2. Map Settings — global default lat/lon/zoom + per-farm coordinates
     (Map Settings.farm_coordinates).
  3. Chemicals — Item rows curated to chemical / fertilizer groups, with
     per-item rate range, IRAC / FRAC / GHS codes, active ingredients,
     and per-chemical target list (custom_targets child table).
  4. Targets — read-only list of Pests + Plant Diseases, used by the
     Chemicals tab when picking what a chemical treats.

All endpoints are gated to General Manager / System Manager via
``_require_admin`` from ``admin.py``.
"""
from __future__ import annotations

import frappe

from upande_scp.serverscripts.cache_utils import K_AFP_WAREHOUSES, invalidate

from .admin import _require_admin


# ──────────────────────────────────────────────────────────────────────
# Bundle: one call to populate every tab on first load.
# ──────────────────────────────────────────────────────────────────────


@frappe.whitelist()
def get_settings_bundle() -> dict:
    _require_admin()

    settings = frappe.get_single("Spray Plan Settings")
    allowed_farms = [
        {"farm": r.farm} for r in (settings.allowed_farms or [])
    ]
    exclude_keywords = [
        {"keyword": r.keyword} for r in (settings.exclude_keywords or [])
    ]

    map_settings = frappe.get_single("Map Settings")
    farm_coords = [
        {
            "farm": r.farm,
            "lat": r.lat,
            "lon": r.lon,
            "default_zoom": r.default_zoom,
        }
        for r in (map_settings.farm_coordinates or [])
    ]

    farms = frappe.get_all(
        "Farm",
        fields=["name"],
        order_by="name",
    )

    return {
        "spray_plan": {
            "intro_note": settings.intro_note or "",
            "irac_rotation_window_days": settings.irac_rotation_window_days or 0,
            "frac_rotation_window_days": settings.frac_rotation_window_days or 0,
            "weather_wind_green_max_kmh": settings.weather_wind_green_max_kmh or 0,
            "weather_wind_red_min_kmh": settings.weather_wind_red_min_kmh or 0,
            "weather_rain_green_max_pct": settings.weather_rain_green_max_pct or 0,
            "weather_rain_red_min_pct": settings.weather_rain_red_min_pct or 0,
            "weather_temp_green_min_c": settings.weather_temp_green_min_c or 0,
            "weather_temp_green_max_c": settings.weather_temp_green_max_c or 0,
            "weather_temp_red_max_c": settings.weather_temp_red_max_c or 0,
            "weather_temp_red_min_c": settings.weather_temp_red_min_c or 0,
            "default_chemical_expense_account": settings.default_chemical_expense_account or "",
            "bypass_owner_check": int(settings.bypass_owner_check or 0),
            "auto_cancel_enabled": int(settings.auto_cancel_enabled or 0),
            "auto_cancel_apply_to_backlog": int(settings.auto_cancel_apply_to_backlog or 0),
            "auto_cancel_dormant_days": settings.auto_cancel_dormant_days or 3,
            "auto_cancel_activated_on": str(settings.auto_cancel_activated_on or ""),
            "loaning_enabled": int(settings.loaning_enabled or 0),
            "loaning_depletion_pct": settings.loaning_depletion_pct or 15,
            "loaning_timeout_hours": settings.loaning_timeout_hours or 72,
            "progress_email_enabled": int(settings.progress_email_enabled or 0),
            "progress_email_hour": settings.progress_email_hour if settings.progress_email_hour is not None else 18,
            "allowed_farms": allowed_farms,
            "exclude_keywords": exclude_keywords,
        },
        "map_settings": {
            "lat": map_settings.lat or 0,
            "lon": map_settings.lon or 0,
            "default_zoom": map_settings.default_zoom or 0,
            "farm_coordinates": farm_coords,
        },
        "farms": [f["name"] for f in farms],
    }


# ──────────────────────────────────────────────────────────────────────
# Spray Plan Settings (Single).
# ──────────────────────────────────────────────────────────────────────


@frappe.whitelist()
def save_spray_plan_settings(payload) -> dict:
    """Save Spray Plan Settings + allowed_farms + exclude_keywords in one go.

    ``payload`` is the same shape ``get_settings_bundle`` returns under
    ``spray_plan``.
    """
    _require_admin()
    if isinstance(payload, str):
        payload = frappe.parse_json(payload)

    settings = frappe.get_single("Spray Plan Settings")
    scalar_fields = [
        "intro_note",
        "irac_rotation_window_days", "frac_rotation_window_days",
        "weather_wind_green_max_kmh", "weather_wind_red_min_kmh",
        "weather_rain_green_max_pct", "weather_rain_red_min_pct",
        "weather_temp_green_min_c", "weather_temp_green_max_c",
        "weather_temp_red_max_c", "weather_temp_red_min_c",
        "default_chemical_expense_account",
        "bypass_owner_check",
        "auto_cancel_enabled",
        "auto_cancel_apply_to_backlog",
        "auto_cancel_dormant_days",
        "loaning_enabled",
        "loaning_depletion_pct",
        "loaning_timeout_hours",
        "progress_email_enabled",
        "progress_email_hour",
    ]
    for f in scalar_fields:
        if f in payload:
            settings.set(f, payload[f])

    # Stamp the going-forward cutoff the first time auto-cancel is enabled.
    # Once stamped it never moves, so toggling the feature off and on again
    # keeps the original cutoff (plans created before first-enable stay in the
    # "backlog" bucket).
    if settings.auto_cancel_enabled and not settings.auto_cancel_activated_on:
        settings.auto_cancel_activated_on = frappe.utils.now_datetime()

    # Rebuild child tables from scratch — simpler than diffing and the
    # set is small. The cache invalidator hooked to "Spray Plan Allowed
    # Farm" / "Spray Plan Exclude Keyword" still fires on the implicit
    # delete + insert, so the warehouse cache rebuilds.
    if "allowed_farms" in payload:
        settings.set("allowed_farms", [])
        for r in payload.get("allowed_farms") or []:
            farm = (r.get("farm") if isinstance(r, dict) else r) or ""
            if farm:
                settings.append("allowed_farms", {"farm": farm})

    if "exclude_keywords" in payload:
        settings.set("exclude_keywords", [])
        for r in payload.get("exclude_keywords") or []:
            kw = (r.get("keyword") if isinstance(r, dict) else r) or ""
            if kw:
                settings.append("exclude_keywords", {"keyword": kw})

    settings.save(ignore_permissions=True)
    # Bust the AFP warehouse cache so the picker reflects the new
    # allowed-farms / exclude-keywords set immediately.
    invalidate(K_AFP_WAREHOUSES)
    return {"ok": True}


# ──────────────────────────────────────────────────────────────────────
# Map Settings + per-farm coordinates.
# ──────────────────────────────────────────────────────────────────────


@frappe.whitelist()
def save_farm_coordinates(payload) -> dict:
    _require_admin()
    if isinstance(payload, str):
        payload = frappe.parse_json(payload)

    settings = frappe.get_single("Map Settings")
    for f in ("lat", "lon", "default_zoom"):
        if f in payload:
            settings.set(f, payload[f])

    if "farm_coordinates" in payload:
        settings.set("farm_coordinates", [])
        for r in payload.get("farm_coordinates") or []:
            if not r.get("farm"):
                continue
            settings.append("farm_coordinates", {
                "farm": r["farm"],
                "lat": r.get("lat") or 0,
                "lon": r.get("lon") or 0,
                "default_zoom": r.get("default_zoom") or 0,
            })

    settings.save(ignore_permissions=True)
    return {"ok": True}


# ──────────────────────────────────────────────────────────────────────
# Targets (Pests + Plant Diseases) — read-only catalog.
# ──────────────────────────────────────────────────────────────────────


@frappe.whitelist()
def list_targets() -> dict:
    """Return pests + plant diseases for the chemical target picker."""
    _require_admin()
    pests = frappe.get_all(
        "Pest",
        fields=["name", "common_name", "scientific_name", "pests_legend_color"],
        order_by="name",
    ) if frappe.db.table_exists("Pest") else []
    diseases = frappe.get_all(
        "Plant Disease",
        fields=["name", "common_name", "disease_legend_color"],
        order_by="name",
    ) if frappe.db.table_exists("Plant Disease") else []
    return {"pests": pests, "diseases": diseases}


# ──────────────────────────────────────────────────────────────────────
# Codes (IRAC / FRAC / GHS) — read-only lookups.
# ──────────────────────────────────────────────────────────────────────


@frappe.whitelist()
def list_codes() -> dict:
    """Return all IRAC / FRAC / GHS codes for the multi-select pickers."""
    _require_admin()
    def _all(doctype: str) -> list[dict]:
        if not frappe.db.table_exists(doctype):
            return []
        return frappe.get_all(doctype, fields=["name"], order_by="name")
    # Active Ingredient is a child table (free-text per row), not a master
    # catalog — the UI builds the list with a plain text input rather than
    # picking from a fixed set.
    return {
        "irac": _all("IRAC Code"),
        "frac": _all("FRAC Code"),
        "ghs": _all("GHS Code"),
    }


# ──────────────────────────────────────────────────────────────────────
# Chemicals (Item rows curated to Chemical / Fertilizer groups).
# ──────────────────────────────────────────────────────────────────────


# Item groups we treat as "chemicals" for spray-plan curation. Matches the
# filter used by the chemical search in the spray-plan creator pages.
_CHEMICAL_GROUPS = ("CHEMICALS", "Chemical", "Chemicals", "FERTILIZERS",
                    "Fertilizer", "Fertilizers")

# Item groups that classify as fertilizer — anything else in
# ``_CHEMICAL_GROUPS`` is treated as a chemical. Used by the Settings UI
# to badge each row and to hide the pest/disease target editor for
# fertilizers (which don't treat pests, they feed plants).
_FERTILIZER_GROUPS_LOWER = {"fertilizers", "fertilizer"}


def _kind_of(item_group: str) -> str:
    return "fertilizer" if (item_group or "").strip().lower() in _FERTILIZER_GROUPS_LOWER else "chemical"


@frappe.whitelist()
def list_chemicals(
    query: str = "",
    page: int = 1,
    page_size: int = 50,
    only_enabled: int = 0,
    kind: str = "",
) -> dict:
    """List Item rows in chemical / fertilizer item groups.

    Supports search across name + item_name + description. ``only_enabled``
    filters to ``disabled = 0``. Returns ``{items, total, page, page_size}``
    with the per-row custom fields the Chemicals tab needs to render.
    """
    _require_admin()
    try:
        page = max(1, int(page))
        page_size = max(1, min(int(page_size), 200))
    except (TypeError, ValueError):
        page, page_size = 1, 50

    q = (query or "").strip()
    like = f"%{q.lower()}%" if q else "%"

    params: dict = {"like": like}
    where = ["item_group IN %(groups)s"]

    # Narrow the group set when the caller asked for one kind only —
    # cheaper than fetching everything and filtering client-side.
    kind = (kind or "").lower()
    if kind == "fertilizer":
        params["groups"] = tuple(g for g in _CHEMICAL_GROUPS
                                 if g.lower() in _FERTILIZER_GROUPS_LOWER)
    elif kind == "chemical":
        params["groups"] = tuple(g for g in _CHEMICAL_GROUPS
                                 if g.lower() not in _FERTILIZER_GROUPS_LOWER)
    else:
        params["groups"] = _CHEMICAL_GROUPS

    if q:
        where.append(
            "(LOWER(name) LIKE %(like)s OR LOWER(item_name) LIKE %(like)s"
            " OR LOWER(COALESCE(description, '')) LIKE %(like)s)"
        )
    if int(only_enabled or 0):
        where.append("disabled = 0")
    where_clause = " AND ".join(where)

    total = frappe.db.sql(
        f"SELECT COUNT(*) FROM `tabItem` WHERE {where_clause}",
        params,
    )[0][0]

    offset = (page - 1) * page_size
    params["limit"] = page_size
    params["offset"] = offset
    rows = frappe.db.sql(
        f"""SELECT name AS item_code,
                   item_name,
                   item_group,
                   stock_uom,
                   disabled,
                   custom_lower_rate_limit,
                   custom_upper_rate_limit,
                   custom_low_stock_threshold,
                   custom_type,
                   custom_toxicity,
                   custom_reentry_interval_hrs,
                   custom_frac_moa,
                   custom_irac_moa,
                   custom_ghs_description
              FROM `tabItem`
             WHERE {where_clause}
             ORDER BY item_name ASC
             LIMIT %(limit)s OFFSET %(offset)s""",
        params,
        as_dict=True,
    )

    # Fetch child-table rows in one shot per table, keyed by item. The
    # column on every Code Filter child table is literally ``code`` —
    # mis-naming it caused saves to fail with a MandatoryError on
    # ``code, code, code, code``.
    codes = (
        ("custom_irac", "IRAC Code Filter", "code"),
        ("custom_frac", "FRAC Code Filter", "code"),
        ("custom_ghs", "GHS Code Filter", "code"),
    )
    code_maps: dict[str, dict[str, list[str]]] = {f: {} for f, _, _ in codes}
    targets_map: dict[str, list[dict]] = {}
    actives_map: dict[str, list[dict]] = {}

    item_codes = [r["item_code"] for r in rows]
    if item_codes:
        for fieldname, child_doctype, value_col in codes:
            child_rows = frappe.db.sql(
                f"""SELECT parent, {value_col} AS code
                      FROM `tab{child_doctype}`
                     WHERE parent IN %(parents)s""",
                {"parents": tuple(item_codes)},
                as_dict=True,
            )
            for cr in child_rows:
                code_maps[fieldname].setdefault(cr["parent"], []).append(cr["code"])

        # Chemical Targets child rows — pest OR disease per row.
        if frappe.db.table_exists("Chemical Targets"):
            target_rows = frappe.db.sql(
                """SELECT parent, pest, disease
                     FROM `tabChemical Targets`
                    WHERE parent IN %(parents)s""",
                {"parents": tuple(item_codes)},
                as_dict=True,
            )
            for tr in target_rows:
                targets_map.setdefault(tr["parent"], []).append({
                    "pest": tr["pest"] or "",
                    "disease": tr["disease"] or "",
                })

        if frappe.db.table_exists("Active Ingredient"):
            ai_rows = frappe.db.sql(
                """SELECT parent, ingredient
                     FROM `tabActive Ingredient`
                    WHERE parent IN %(parents)s""",
                {"parents": tuple(item_codes)},
                as_dict=True,
            )
            for ar in ai_rows:
                ing = (ar.get("ingredient") or "").strip()
                if ing:
                    actives_map.setdefault(ar["parent"], []).append(ing)

    for r in rows:
        code = r["item_code"]
        r["enabled"] = not r["disabled"]
        r["kind"] = _kind_of(r.get("item_group") or "")
        r["irac"] = code_maps["custom_irac"].get(code, [])
        r["frac"] = code_maps["custom_frac"].get(code, [])
        r["ghs"] = code_maps["custom_ghs"].get(code, [])
        r["targets"] = targets_map.get(code, [])
        r["active_ingredients"] = actives_map.get(code, [])

    return {
        "items": rows,
        "total": int(total),
        "page": page,
        "page_size": page_size,
    }


@frappe.whitelist()
def save_chemical(item_code: str, payload) -> dict:
    """Save the editable fields on a single Item.

    ``payload`` may include any of:
      * ``enabled``    -> writes ``disabled = !enabled``
      * ``lower_rate_limit`` / ``upper_rate_limit`` (Float)
      * ``frac_moa`` / ``irac_moa`` / ``ghs_description`` (text)
      * ``irac`` / ``frac`` / ``ghs`` (lists of code names)
      * ``targets`` (list of ``{pest, disease}`` dicts; exactly one set per row)
      * ``active_ingredients`` (list of ``{active_ingredient, concentration, uom}``)
    """
    _require_admin()
    if isinstance(payload, str):
        payload = frappe.parse_json(payload)

    if not frappe.db.exists("Item", item_code):
        frappe.throw(f"Item '{item_code}' not found.", title="Unknown chemical")

    item = frappe.get_doc("Item", item_code)

    if "enabled" in payload:
        item.disabled = 0 if payload.get("enabled") else 1
    for fld in (
        "lower_rate_limit",
        "upper_rate_limit",
        "reentry_interval_hrs",
        "low_stock_threshold",
    ):
        if fld in payload:
            item.set(f"custom_{fld}", payload[fld] or 0)
    for fld in ("frac_moa", "irac_moa", "ghs_description", "type", "toxicity"):
        if fld in payload:
            item.set(f"custom_{fld}", payload[fld] or "")

    # The link column on every Code Filter child table is named ``code`` —
    # writing ``irac_code`` / ``frac_code`` / ``ghs_code`` here left the
    # required field empty and triggered a MandatoryError on save.
    for payload_key, fieldname in (
        ("irac", "custom_irac"),
        ("frac", "custom_frac"),
        ("ghs",  "custom_ghs"),
    ):
        if payload_key in payload:
            item.set(fieldname, [])
            for code in payload.get(payload_key) or []:
                if not code:
                    continue
                item.append(fieldname, {"code": code})

    if "targets" in payload:
        item.set("custom_targets", [])
        for row in payload.get("targets") or []:
            pest = (row.get("pest") or "").strip() if isinstance(row, dict) else ""
            disease = (row.get("disease") or "").strip() if isinstance(row, dict) else ""
            if not pest and not disease:
                continue
            item.append("custom_targets", {"pest": pest, "disease": disease})

    if "active_ingredients" in payload:
        item.set("custom_active_ingredients", [])
        for row in payload.get("active_ingredients") or []:
            ing = (row.strip() if isinstance(row, str)
                   else (row.get("ingredient") or "").strip()) if row else ""
            if not ing:
                continue
            item.append("custom_active_ingredients", {"ingredient": ing})

    item.flags.ignore_validate_update_after_submit = True
    item.save(ignore_permissions=True)
    return {"ok": True, "item_code": item_code}
