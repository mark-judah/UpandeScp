"""
scouting_metrics.py
===================
Centralized data fetchers for scouting and moth/trap analytics.

Used by both the KEPHIS weekly Excel report and the scouting dashboard so
definitions (active beds, indoor vs outdoor traps, what counts as "Others")
stay consistent.

Two categories of helpers:

Inventory lookups (no date filter, cached via scouting_metrics_api wrappers)
    - get_farms
    - get_farms_and_greenhouses
    - get_greenhouses_by_farm
    - get_beds_by_greenhouse      (active beds only by default)
    - get_zones_by_greenhouse
    - get_traps_by_greenhouse     (split into indoor / outdoor)

Report aggregations (all accept an optional ``farm`` filter — when supplied
the numbers are restricted to that farm only; omit for cross-farm totals)
    - get_fcm_traps_ordered
    - get_fcm_trap_counts_weekly          (per trap / week / location, Sheet 1)
    - get_weekly_trap_pest_totals_indoor  (indoor trap scouting only, Sheet 2)
    - get_plant_pests_weekly              (per GH / week, Sheets 3 & 4)
    - get_fcm_larvae_weekly               (per GH / week, Sheet 1 column H)
    - get_scouting_records_weekly         (per-entry audit trail, Scouting Records sheet)
"""

from collections import defaultdict

import frappe


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# The "Others" bucket in the Weekly summary / Scouting summary sheets covers
# non-FCM / non-Helicoverpa moth species only. Any other pest (aphids, thrips,
# mites, etc.) must NOT contribute to this bucket — previously they did,
# producing artificially large totals.
MOTH_OTHERS = ("Spodoptera", "Duponchella", "Unidentified Moth")


# ---------------------------------------------------------------------------
# Inventory lookups
# ---------------------------------------------------------------------------

def get_farms():
    """Return a sorted list of farm names that have at least one greenhouse."""
    rows = frappe.db.sql(
        """
        SELECT DISTINCT custom_farm AS farm
        FROM   `tabWarehouse`
        WHERE  warehouse_type = 'Greenhouse'
          AND  disabled = 0
          AND  is_group = 0
          AND  custom_farm IS NOT NULL AND custom_farm != ''
        ORDER  BY custom_farm
        """,
        as_dict=True,
    )
    return [r.farm for r in rows]


def get_farms_and_greenhouses():
    """Return {farm: [greenhouse_name, ...]} for every active greenhouse."""
    rows = frappe.db.sql(
        """
        SELECT name, custom_farm AS farm
        FROM   `tabWarehouse`
        WHERE  warehouse_type = 'Greenhouse'
          AND  disabled = 0
          AND  is_group = 0
        ORDER  BY custom_farm, name
        """,
        as_dict=True,
    )
    grouped = defaultdict(list)
    for r in rows:
        farm = r.farm or "(no farm)"
        grouped[farm].append(r.name)
    return dict(grouped)


def get_greenhouses_by_farm(farm=None):
    """List greenhouses; optionally filtered to one farm."""
    conditions = ["warehouse_type = 'Greenhouse'", "disabled = 0", "is_group = 0"]
    params = []
    if farm:
        conditions.append("custom_farm = %s")
        params.append(farm)
    return frappe.db.sql(
        f"""
        SELECT name, custom_farm AS farm, parent_warehouse
        FROM   `tabWarehouse`
        WHERE  {" AND ".join(conditions)}
        ORDER  BY name
        """,
        tuple(params),
        as_dict=True,
    )


def get_beds_by_greenhouse(active_only=True):
    """Return {greenhouse: [{name, bed, unit_type, variety, bed__area}, ...]}.

    Active-only by default (``custom_active = 1``) because retired beds should
    not inflate denominators on dashboards or report totals.
    """
    conditions = ["greenhouse IS NOT NULL", "greenhouse != ''"]
    if active_only:
        conditions.append("custom_active = 1")
    rows = frappe.db.sql(
        f"""
        SELECT name, greenhouse, bed, unit_type, variety, bed__area
        FROM   `tabBed`
        WHERE  {" AND ".join(conditions)}
        ORDER  BY greenhouse, unit_type, bed
        """,
        as_dict=True,
    )
    grouped = defaultdict(list)
    for r in rows:
        grouped[r.greenhouse].append(
            {
                "name": r.name,
                "bed": r.bed,
                "unit_type": r.unit_type,
                "variety": r.variety,
                "bed__area": r.bed__area,
            }
        )
    return dict(grouped)


def get_zone_counts_by_greenhouse():
    """Return {greenhouse: zone_count}.

    Flat-count variant of ``get_zones_by_greenhouse`` used where only a
    denominator is needed (e.g. zone-coverage % on the dashboard). Falls back
    to counting non-group child warehouses per parent when the Zone doctype
    has no rows — bootstrap safety carried over from the legacy fetcher.
    """
    rows = frappe.db.sql(
        """
        SELECT greenhouse, COUNT(*) AS zone_count
        FROM   `tabZone`
        WHERE  greenhouse IS NOT NULL AND greenhouse != ''
        GROUP  BY greenhouse
        """,
        as_dict=True,
    )
    counts = {r.greenhouse: r.zone_count for r in rows}
    if counts:
        return counts

    legacy = frappe.get_all(
        "Warehouse",
        filters=[["is_group", "=", 0]],
        fields=["parent_warehouse"],
        limit_page_length=0,
    )
    for row in legacy:
        parent = (row.get("parent_warehouse") or "").strip()
        if parent:
            counts[parent] = counts.get(parent, 0) + 1
    return counts


def get_units_by_warehouse():
    """Return {warehouse_name: {"type": "greenhouse"|"block", "count": N, "farm": str, "area_ha": float}}.

    Greenhouses → number of Zones; blocks → number of Orchard Trees. ``area_ha``
    comes from ``Warehouse.custom_area_ha`` and is the denominator for
    Per-Hectare severity thresholds. Drives the "Zone Coverage %" / "Tree
    Coverage %" denominator on the scouting dashboard so pressure metrics
    match the right unit per warehouse type.
    """
    # Single warehouse pass: type, farm, and area_ha for every active GH/Block.
    wh_rows = frappe.db.sql(
        """
        SELECT name, warehouse_type, custom_farm AS farm,
               COALESCE(custom_area_ha, 0) AS area_ha
        FROM   `tabWarehouse`
        WHERE  warehouse_type IN ('Greenhouse', 'Block')
          AND  disabled = 0
          AND  is_group = 0
        """,
        as_dict=True,
    )
    out = {}
    for r in wh_rows:
        out[r.name] = {
            "type": "block" if r.warehouse_type == "Block" else "greenhouse",
            "count": 0,
            "farm": r.farm or "",
            "area_ha": float(r.area_ha or 0),
        }

    zone_counts = frappe.db.sql(
        """
        SELECT greenhouse AS wh, COUNT(*) AS cnt
        FROM   `tabZone`
        WHERE  greenhouse IS NOT NULL AND greenhouse != ''
        GROUP  BY greenhouse
        """,
        as_dict=True,
    )
    for r in zone_counts:
        if r.wh in out:
            out[r.wh]["count"] = int(r.cnt or 0)
        else:
            # Zone references an inactive / non-listed warehouse — keep it
            # rather than silently dropping; assume greenhouse-type.
            out[r.wh] = {"type": "greenhouse", "count": int(r.cnt or 0), "farm": "", "area_ha": 0.0}

    tree_counts = frappe.db.sql(
        """
        SELECT block AS wh, COUNT(*) AS cnt
        FROM   `tabOrchard Tree`
        WHERE  block IS NOT NULL AND block != ''
        GROUP  BY block
        """,
        as_dict=True,
    )
    for r in tree_counts:
        if r.wh in out:
            out[r.wh]["type"] = "block"
            out[r.wh]["count"] = int(r.cnt or 0)
        else:
            out[r.wh] = {"type": "block", "count": int(r.cnt or 0), "farm": "", "area_ha": 0.0}
    return out


def get_severity_thresholds():
    """Return {crop: {"pests": {pest: {...}}, "diseases": {disease: {...}}}}.

    Each leaf carries ``unit``, ``low``, ``moderate``, ``high``. Drives the
    dashboard's pest/disease severity classifier — replaces the legacy
    hardcoded ``count > 5`` / ``count > 15`` heuristic with per-crop, per-pest
    bands configured on Crop Scouted. Missing entries simply mean "no
    severity classification configured for this crop+pest combo".
    """
    pests = frappe.db.sql(
        """
        SELECT parent AS crop, pest, unit, low_threshold, moderate_threshold, high_threshold
        FROM   `tabPest Filter`
        WHERE  parenttype = 'Crop Scouted' AND pest IS NOT NULL AND pest != ''
        """,
        as_dict=True,
    )
    diseases = frappe.db.sql(
        """
        SELECT parent AS crop, disease, unit, low_threshold, moderate_threshold, high_threshold
        FROM   `tabDisease Filter`
        WHERE  parenttype = 'Crop Scouted' AND disease IS NOT NULL AND disease != ''
        """,
        as_dict=True,
    )
    out = {}
    for r in pests:
        bucket = out.setdefault(r.crop, {"pests": {}, "diseases": {}})
        bucket["pests"][r.pest] = {
            "unit": r.unit or "Per Warehouse",
            "low": float(r.low_threshold or 0),
            "moderate": float(r.moderate_threshold or 0),
            "high": float(r.high_threshold or 0),
        }
    for r in diseases:
        bucket = out.setdefault(r.crop, {"pests": {}, "diseases": {}})
        bucket["diseases"][r.disease] = {
            "unit": r.unit or "Per Warehouse",
            "low": float(r.low_threshold or 0),
            "moderate": float(r.moderate_threshold or 0),
            "high": float(r.high_threshold or 0),
        }
    return out


def get_farms_and_warehouses():
    """Return {farm: [warehouse_name, ...]} including both greenhouses and blocks.

    Companion to ``get_farms_and_greenhouses`` which only lists greenhouses;
    block-based farms (avocado orchards etc.) need to show up so the dashboard
    can scope to them.
    """
    rows = frappe.db.sql(
        """
        SELECT name, custom_farm AS farm
        FROM   `tabWarehouse`
        WHERE  warehouse_type IN ('Greenhouse', 'Block')
          AND  disabled = 0
          AND  is_group = 0
        ORDER  BY custom_farm, name
        """,
        as_dict=True,
    )
    grouped = defaultdict(list)
    for r in rows:
        farm = r.farm or "(no farm)"
        grouped[farm].append(r.name)
    return dict(grouped)


def get_crops_with_farms():
    """Return [{name, crop_name, farms: [...]}] for every Crop Scouted record.

    Powers the dashboard Crop filter and the farm-narrowing behaviour: when a
    crop is selected, the Farm dropdown is restricted to that crop's ``farms``
    allow-list.
    """
    crops = frappe.get_all(
        "Crop Scouted",
        fields=["name", "crop_name"],
        order_by="crop_name",
        limit_page_length=0,
    )
    if not crops:
        return []
    farm_rows = frappe.db.sql(
        """
        SELECT parent, farm
        FROM   `tabFarm Filter`
        WHERE  parenttype = 'Crop Scouted'
        """,
        as_dict=True,
    )
    farms_by_crop = defaultdict(list)
    for r in farm_rows:
        if r.farm:
            farms_by_crop[r.parent].append(r.farm)
    return [
        {
            "name": c.name,
            "crop_name": c.crop_name or c.name,
            "farms": sorted(set(farms_by_crop.get(c.name, []))),
        }
        for c in crops
    ]


def get_zones_by_greenhouse():
    """Return {greenhouse: [{name, bed, zone}, ...]} for every Zone."""
    rows = frappe.db.sql(
        """
        SELECT name, greenhouse, bed, zone
        FROM   `tabZone`
        WHERE  greenhouse IS NOT NULL AND greenhouse != ''
        ORDER  BY greenhouse, bed, zone
        """,
        as_dict=True,
    )
    grouped = defaultdict(list)
    for r in rows:
        grouped[r.greenhouse].append({"name": r.name, "bed": r.bed, "zone": r.zone})
    return dict(grouped)


def get_traps_by_greenhouse(trap_type=None):
    """Return {greenhouse: {"indoor": [...], "outdoor": [...]}}.

    Each trap dict: name, trap_number, location, type, farm.
    If ``trap_type`` is given (e.g. "FCM") only traps of that type are returned.
    """
    conditions = ["greenhouse IS NOT NULL", "greenhouse != ''"]
    params = []
    if trap_type:
        conditions.append("type = %s")
        params.append(trap_type)

    rows = frappe.db.sql(
        f"""
        SELECT name, greenhouse, trap_number, location, type, farm
        FROM   `tabTrap`
        WHERE  {" AND ".join(conditions)}
        ORDER  BY greenhouse, CAST(trap_number AS UNSIGNED)
        """,
        tuple(params),
        as_dict=True,
    )

    grouped = defaultdict(lambda: {"indoor": [], "outdoor": []})
    for r in rows:
        bucket = "outdoor" if (r.location or "").strip().lower() == "outdoor" else "indoor"
        grouped[r.greenhouse][bucket].append(
            {
                "name": r.name,
                "trap_number": r.trap_number,
                "location": r.location or "Indoor",
                "type": r.type,
                "farm": r.farm,
            }
        )
    return dict(grouped)


# ---------------------------------------------------------------------------
# Report aggregations
# ---------------------------------------------------------------------------

def get_fcm_traps_ordered(farm=None):
    """All FCM-type traps ordered by numeric trap_number (optionally farm-scoped)."""
    cond = "type = 'FCM'"
    params = []
    if farm:
        cond += " AND farm = %s"
        params.append(farm)
    return frappe.db.sql(
        f"""
        SELECT name, greenhouse, trap_number, location, farm
        FROM   `tabTrap`
        WHERE  {cond}
        ORDER  BY CAST(trap_number AS UNSIGNED)
        """,
        tuple(params),
        as_dict=True,
    )


def get_fcm_trap_counts_weekly(year, farm=None):
    """FCM observations per (week, trap, location).

    Location falls back to the trap's configured location when the scouting
    entry doesn't specify one. When ``farm`` is given, only traps belonging
    to that farm are counted.
    """
    cond = ""
    params = [year]
    if farm:
        cond = " AND t.farm = %s "
        params.append(farm)
    return frappe.db.sql(
        f"""
        SELECT
            tse.trap,
            COALESCE(tse.location, t.location, 'Indoor') AS location,
            SUM(tse.count)                                AS cnt,
            WEEK(se.date_of_capture, 1)                   AS wk
        FROM  `tabTrap Scouting Entry` tse
        JOIN  `tabScouting Entry` se ON se.name = tse.parent
        LEFT JOIN `tabTrap` t ON t.name = tse.trap
        WHERE YEAR(se.date_of_capture) = %s
          AND tse.pest = 'FCM'
          {cond}
        GROUP BY tse.trap, location, WEEK(se.date_of_capture, 1)
        """,
        tuple(params),
        as_dict=True,
    )


def get_weekly_trap_pest_totals_indoor(year, farm=None):
    """Weekly pest totals restricted to indoor trap scouting only.

    Powers the Weekly summary sheet. Location resolution matches
    ``get_fcm_trap_counts_weekly``: scouting-entry value wins, otherwise the
    trap's configured location; entries resolving to "Outdoor" are excluded.
    """
    cond = ""
    params = [year]
    if farm:
        cond = " AND t.farm = %s "
        params.append(farm)
    return frappe.db.sql(
        f"""
        SELECT
            tse.pest,
            SUM(tse.count)              AS cnt,
            WEEK(se.date_of_capture, 1) AS wk
        FROM  `tabTrap Scouting Entry` tse
        JOIN  `tabScouting Entry` se ON se.name = tse.parent
        LEFT JOIN `tabTrap` t ON t.name = tse.trap
        WHERE YEAR(se.date_of_capture) = %s
          AND tse.count > 0
          AND tse.pest IS NOT NULL AND tse.pest != ''
          AND COALESCE(tse.location, t.location, 'Indoor') = 'Indoor'
          {cond}
        GROUP BY tse.pest, WEEK(se.date_of_capture, 1)
        """,
        tuple(params),
        as_dict=True,
    )


def get_plant_pests_weekly(year, farm=None):
    """Plant-level pests per (pest, stage, greenhouse, week), optionally farm-scoped."""
    cond = ""
    params = [year]
    if farm:
        cond = " AND gh.custom_farm = %s "
        params.append(farm)
    return frappe.db.sql(
        f"""
        SELECT
            pse.pest,
            pse.stage,
            SUM(pse.count)              AS cnt,
            se.greenhouse,
            WEEK(se.date_of_capture, 1) AS wk
        FROM  `tabPests Scouting Entry` pse
        JOIN  `tabScouting Entry` se ON se.name = pse.parent
        LEFT JOIN `tabWarehouse` gh ON gh.name = se.greenhouse
        WHERE YEAR(se.date_of_capture) = %s
          AND pse.count > 0
          {cond}
        GROUP BY pse.pest, pse.stage, se.greenhouse, WEEK(se.date_of_capture, 1)
        """,
        tuple(params),
        as_dict=True,
    )


def get_fcm_larvae_weekly(year, farm=None):
    """FCM cumulative larvae/eggs per (greenhouse, week) — column H of Sheet 1."""
    cond = ""
    params = [year]
    if farm:
        cond = " AND gh.custom_farm = %s "
        params.append(farm)
    return frappe.db.sql(
        f"""
        SELECT
            SUM(pse.count)              AS cnt,
            se.greenhouse,
            WEEK(se.date_of_capture, 1) AS wk
        FROM  `tabPests Scouting Entry` pse
        JOIN  `tabScouting Entry` se ON se.name = pse.parent
        LEFT JOIN `tabWarehouse` gh ON gh.name = se.greenhouse
        WHERE YEAR(se.date_of_capture) = %s
          AND pse.pest = 'FCM'
          AND LOWER(pse.stage) REGEXP 'egg|larva|larvae|nymph'
          {cond}
        GROUP BY se.greenhouse, WEEK(se.date_of_capture, 1)
        """,
        tuple(params),
        as_dict=True,
    )


def get_scouting_records_weekly(year, farm=None):
    """Per-entry audit records backing the summary numbers.

    Returns a flat list of every pest-plant and trap observation in ``year``
    (optionally restricted to ``farm``), with enough context to reconcile any
    number on the Scouting Summary / Weekly summary / FCM Daily sheets back to
    the original Scouting Entry and the scout who recorded it.

    Fields per row:
        wk, date_of_capture, time_of_capture, scout, scout_employee,
        greenhouse, bed, zone, block, row, tree,
        entry_type ('Plant' | 'Trap'), trap, pest, stage_or_location, count,
        scouting_entry
    """
    gh_cond = " AND gh.custom_farm = %s " if farm else ""
    trap_cond = " AND t.farm = %s " if farm else ""
    params_plant = [year] + ([farm] if farm else [])
    params_trap  = [year] + ([farm] if farm else [])

    plant = frappe.db.sql(
        f"""
        SELECT
            WEEK(se.date_of_capture, 1)  AS wk,
            se.date_of_capture,
            se.time_of_capture,
            se.scouts_name               AS scout_employee,
            COALESCE(emp.employee_name, se.scouts_name) AS scout,
            se.greenhouse,
            se.bed, se.zone, se.block, se.`row`, se.tree,
            'Plant'                      AS entry_type,
            NULL                         AS trap,
            pse.pest,
            pse.stage                    AS stage_or_location,
            pse.count,
            se.name                      AS scouting_entry
        FROM  `tabPests Scouting Entry` pse
        JOIN  `tabScouting Entry` se ON se.name = pse.parent
        LEFT JOIN `tabWarehouse` gh ON gh.name = se.greenhouse
        LEFT JOIN `tabEmployee`  emp ON emp.name = se.scouts_name
        WHERE YEAR(se.date_of_capture) = %s
          AND pse.count > 0
          {gh_cond}
        """,
        tuple(params_plant),
        as_dict=True,
    )

    trap = frappe.db.sql(
        f"""
        SELECT
            WEEK(se.date_of_capture, 1)  AS wk,
            se.date_of_capture,
            se.time_of_capture,
            se.scouts_name               AS scout_employee,
            COALESCE(emp.employee_name, se.scouts_name) AS scout,
            se.greenhouse,
            se.bed, se.zone, se.block, se.`row`, se.tree,
            'Trap'                       AS entry_type,
            tse.trap,
            tse.pest,
            COALESCE(tse.location, t.location, 'Indoor') AS stage_or_location,
            tse.count,
            se.name                      AS scouting_entry
        FROM  `tabTrap Scouting Entry` tse
        JOIN  `tabScouting Entry` se ON se.name = tse.parent
        LEFT JOIN `tabTrap`      t  ON t.name = tse.trap
        LEFT JOIN `tabEmployee`  emp ON emp.name = se.scouts_name
        WHERE YEAR(se.date_of_capture) = %s
          AND tse.count > 0
          {trap_cond}
        """,
        tuple(params_trap),
        as_dict=True,
    )

    combined = list(plant) + list(trap)
    combined.sort(
        key=lambda r: (
            r.get("wk") or 0,
            r.get("date_of_capture") or "",
            str(r.get("time_of_capture") or ""),
            r.get("greenhouse") or "",
        )
    )
    return combined
