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

from upande_scp.serverscripts.common.cache_utils import K_AFP_WAREHOUSES, invalidate

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
    chemical_stores = [
        {"warehouse": r.warehouse} for r in (settings.get("chemical_stores") or [])
    ]
    fertigation_stores = [
        {"warehouse": r.warehouse} for r in (settings.get("fertigation_stores") or [])
    ]

    # Store-picker options: non-group, non-disabled warehouses.
    warehouses = frappe.get_all(
        "Warehouse",
        filters={"disabled": 0, "is_group": 0},
        pluck="name",
        order_by="name asc",
    )

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
            "scan_verification_method": settings.scan_verification_method or "Scan Labels",
            "bypass_biometric_on_issue": int(settings.bypass_biometric_on_issue or 0),
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
            "chemical_stores": chemical_stores,
            "fertigation_stores": fertigation_stores,
        },
        "warehouses": warehouses,
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
        "scan_verification_method",
        "bypass_biometric_on_issue",
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

    for field in ("chemical_stores", "fertigation_stores"):
        if field in payload:
            settings.set(field, [])
            for r in payload.get(field) or []:
                wh = (r.get("warehouse") if isinstance(r, dict) else r) or ""
                if wh:
                    settings.append(field, {"warehouse": wh})

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
    # Item row carries identity + stock state + the descriptive MoA/GHS text
    # (those stay Item-side); chemical metadata comes from the Chemical master.
    rows = frappe.db.sql(
        f"""SELECT name AS item_code, item_name, item_group, stock_uom, disabled,
                   custom_low_stock_threshold,
                   custom_frac_moa, custom_irac_moa, custom_ghs_description
              FROM `tabItem`
             WHERE {where_clause}
             ORDER BY item_name ASC
             LIMIT %(limit)s OFFSET %(offset)s""",
        params,
        as_dict=True,
    )
    item_codes = [r["item_code"] for r in rows]

    def _child(table, cols, parents, parenttype):
        out: dict[str, list[dict]] = {}
        if not parents:
            return out
        for cr in frappe.db.sql(
            f"SELECT parent, {cols} FROM `tab{table}` "
            "WHERE parent IN %(p)s AND parenttype = %(pt)s",
            {"p": tuple(parents), "pt": parenttype},
            as_dict=True,
        ):
            out.setdefault(cr["parent"], []).append(cr)
        return out

    # Scalar metadata from the Chemical master (source of truth).
    chem: dict[str, dict] = {}
    if item_codes:
        for c in frappe.db.sql(
            """SELECT item, allowed, type, toxicity, reentry_interval_hrs,
                      default_lower_rate_limit AS lower_rate_limit,
                      default_upper_rate_limit AS upper_rate_limit
                 FROM `tabChemical` WHERE item IN %(p)s""",
            {"p": tuple(item_codes)},
            as_dict=True,
        ):
            chem[c["item"]] = c
    with_chem = [c for c in item_codes if c in chem]
    no_chem = [c for c in item_codes if c not in chem]

    # Child rows — from Chemical for backfilled chemicals, from Item otherwise.
    c_irac = _child("IRAC Code Filter", "code", with_chem, "Chemical")
    c_frac = _child("FRAC Code Filter", "code", with_chem, "Chemical")
    c_ghs = _child("GHS Code Filter", "code", with_chem, "Chemical")
    c_tgt = _child("Chemical Targets", "pest, disease", with_chem, "Chemical")
    c_ai = _child("Active Ingredient", "ingredient", with_chem, "Chemical")
    c_crop = _child("Chemical Crop", "crop", with_chem, "Chemical")
    i_irac = _child("IRAC Code Filter", "code", no_chem, "Item")
    i_frac = _child("FRAC Code Filter", "code", no_chem, "Item")
    i_ghs = _child("GHS Code Filter", "code", no_chem, "Item")
    i_tgt = _child("Chemical Targets", "pest, disease", no_chem, "Item")
    i_ai = _child("Active Ingredient", "ingredient", no_chem, "Item")
    item_extra: dict[str, dict] = {}
    if no_chem:
        for it in frappe.db.sql(
            """SELECT name, custom_type, custom_toxicity, custom_reentry_interval_hrs,
                      custom_lower_rate_limit, custom_upper_rate_limit
                 FROM `tabItem` WHERE name IN %(p)s""",
            {"p": tuple(no_chem)},
            as_dict=True,
        ):
            item_extra[it["name"]] = it

    for r in rows:
        code = r["item_code"]
        r["enabled"] = not r["disabled"]
        r["kind"] = _kind_of(r.get("item_group") or "")
        if code in chem:
            c = chem[code]
            r["allowed"] = bool(c["allowed"])
            r["custom_type"] = c["type"]
            r["custom_toxicity"] = c["toxicity"]
            r["custom_reentry_interval_hrs"] = c["reentry_interval_hrs"]
            r["custom_lower_rate_limit"] = c["lower_rate_limit"]
            r["custom_upper_rate_limit"] = c["upper_rate_limit"]
            irac_m, frac_m, ghs_m, tgt_m, ai_m = c_irac, c_frac, c_ghs, c_tgt, c_ai
            r["crops"] = [x["crop"] for x in c_crop.get(code, []) if x.get("crop")]
        else:
            it = item_extra.get(code, {})
            r["allowed"] = True  # no Chemical row → ungated (e.g. fertilizers)
            r["custom_type"] = it.get("custom_type")
            r["custom_toxicity"] = it.get("custom_toxicity")
            r["custom_reentry_interval_hrs"] = it.get("custom_reentry_interval_hrs")
            r["custom_lower_rate_limit"] = it.get("custom_lower_rate_limit")
            r["custom_upper_rate_limit"] = it.get("custom_upper_rate_limit")
            irac_m, frac_m, ghs_m, tgt_m, ai_m = i_irac, i_frac, i_ghs, i_tgt, i_ai
            r["crops"] = []
        r["irac"] = [x["code"] for x in irac_m.get(code, [])]
        r["frac"] = [x["code"] for x in frac_m.get(code, [])]
        r["ghs"] = [x["code"] for x in ghs_m.get(code, [])]
        r["targets"] = [
            {"pest": x["pest"] or "", "disease": x["disease"] or ""}
            for x in tgt_m.get(code, [])
        ]
        r["active_ingredients"] = [
            x["ingredient"].strip()
            for x in ai_m.get(code, [])
            if (x.get("ingredient") or "").strip()
        ]

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
    # The Item (stock master) keeps only enable/disable + the descriptive
    # MoA/GHS text; all chemical metadata lives on the Chemical master.
    if "enabled" in payload:
        item.disabled = 0 if payload.get("enabled") else 1
    if "low_stock_threshold" in payload:
        item.set("custom_low_stock_threshold", payload["low_stock_threshold"] or 0)
    for fld in ("frac_moa", "irac_moa", "ghs_description"):
        if fld in payload:
            item.set(f"custom_{fld}", payload[fld] or "")
    item.flags.ignore_validate_update_after_submit = True
    item.save(ignore_permissions=True)

    is_chemical = (item.item_group == "Chemicals")

    def _apply_codes_targets(doc, prefix, targets_field=None):
        # prefix "" for Chemical (fields irac/frac/ghs/active_ingredients),
        # "custom_" for the legacy Item fields. The Code Filter link column is
        # literally ``code``. The targets table is named separately because
        # Chemical calls it `default_targets` while Item calls it
        # `custom_targets`.
        targets_field = targets_field or f"{prefix}targets"
        for key in ("irac", "frac", "ghs"):
            if key in payload:
                doc.set(f"{prefix}{key}", [])
                for code in payload.get(key) or []:
                    if code:
                        doc.append(f"{prefix}{key}", {"code": code})
        if "targets" in payload:
            doc.set(targets_field, [])
            for row in payload.get("targets") or []:
                pest = (row.get("pest") or "").strip() if isinstance(row, dict) else ""
                disease = (row.get("disease") or "").strip() if isinstance(row, dict) else ""
                if pest or disease:
                    doc.append(targets_field, {"pest": pest, "disease": disease})
        if "active_ingredients" in payload:
            doc.set(f"{prefix}active_ingredients", [])
            for row in payload.get("active_ingredients") or []:
                ing = (row.strip() if isinstance(row, str)
                       else (row.get("ingredient") or "").strip()) if row else ""
                if ing:
                    doc.append(f"{prefix}active_ingredients", {"ingredient": ing})

    if not is_chemical:
        # Fertilizers etc. have no Chemical master row — keep legacy Item fields.
        for fld in ("lower_rate_limit", "upper_rate_limit", "reentry_interval_hrs"):
            if fld in payload:
                item.set(f"custom_{fld}", payload[fld] or 0)
        for fld in ("type", "toxicity"):
            if fld in payload:
                item.set(f"custom_{fld}", payload[fld] or "")
        _apply_codes_targets(item, "custom_")
        item.save(ignore_permissions=True)
        return {"ok": True, "item_code": item_code}

    chem = (
        frappe.get_doc("Chemical", item_code)
        if frappe.db.exists("Chemical", item_code)
        else frappe.new_doc("Chemical")
    )
    chem.item = item_code
    if "allowed" in payload:
        chem.allowed = 1 if payload.get("allowed") else 0
    for fld in ("lower_rate_limit", "upper_rate_limit"):
        if fld in payload:
            chem.set(f"default_{fld}", payload[fld] or 0)
    if "reentry_interval_hrs" in payload:
        chem.set("reentry_interval_hrs", payload["reentry_interval_hrs"] or 0)
    for fld in ("type", "toxicity"):
        if fld in payload:
            chem.set(fld, payload[fld] or "")
    _apply_codes_targets(chem, "", targets_field="default_targets")
    if "crops" in payload:
        chem.set("crop_scouted", [])
        for crop in payload.get("crops") or []:
            cv = crop.strip() if isinstance(crop, str) else (crop.get("crop") or "").strip()
            if cv:
                chem.append("crop_scouted", {"crop": cv})
    chem.flags.ignore_permissions = True
    chem.save()
    return {"ok": True, "item_code": item_code}
