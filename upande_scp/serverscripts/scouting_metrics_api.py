"""
scouting_metrics_api.py
=======================
Whitelisted, cached HTTP wrappers around ``scouting_metrics``. The dashboard
and any other UI consumer should call these endpoints so the raw SQL lives in
exactly one place.

Invalidation is driven by ``cache_utils.invalidate_on_change`` (hooked via
``hooks.py`` on Zone / Bed / Warehouse / Farm / Trap doc events), so the TTL
is mostly a safety net — edits flush immediately.
"""

import frappe

from upande_scp.serverscripts import scouting_metrics
from upande_scp.serverscripts.cache_utils import (
    K_CROPS_SCOUTED,
    K_MAP_SETTINGS,
    K_SM_BEDS_BY_GH,
    K_SM_FARMS_AND_GHS,
    K_SM_FARMS_AND_WHS,
    K_SM_SEVERITY_THRESHOLDS,
    K_SM_TRAPS_BY_GH,
    K_SM_UNITS_BY_WH,
    K_SM_ZONES_BY_GH,
    TTL_LONG,
    TTL_MEDIUM,
    get_or_set,
)


@frappe.whitelist()
def get_farms_and_greenhouses():
    """{farm: [greenhouse_name, ...]} — active greenhouses only."""
    return get_or_set(
        K_SM_FARMS_AND_GHS,
        scouting_metrics.get_farms_and_greenhouses,
        ttl=TTL_MEDIUM,
    )


def _build_map_settings():
    """Read Map Settings + its child Farm Map Coordinate rows into a flat
    dict the SPA can fly the map to.

    Returns:
        {
          lat, lon, default_zoom: float — the global fallback view,
          farms: { farm_name: { lat, lon, zoom } } — per-farm overrides
        }
    """
    doc = frappe.get_doc("Map Settings", "Map Settings")
    farms = {}
    for row in (doc.get("farm_coordinates") or []):
        farm = (row.farm or "").strip()
        if not farm:
            continue
        if row.lat in (None, 0) and row.lon in (None, 0):
            continue
        farms[farm] = {
            "lat": float(row.lat or 0),
            "lon": float(row.lon or 0),
            "zoom": float(row.default_zoom or doc.default_zoom or 16),
        }
    return {
        "lat": float(doc.lat or 0),
        "lon": float(doc.lon or 0),
        "default_zoom": float(doc.default_zoom or 16),
        "farms": farms,
    }


@frappe.whitelist()
def get_map_settings():
    """Cached Map Settings payload for the React SPA's fly-to logic.

    Cache invalidates automatically when ``Map Settings`` or
    ``Farm Map Coordinate`` rows are saved (see ``cache_utils._DOC_INVALIDATIONS``).
    """
    return get_or_set(K_MAP_SETTINGS, _build_map_settings, ttl=TTL_LONG)


@frappe.whitelist()
def get_latest_scouting_date(greenhouse=None):
    """Most recent ``Scouting Entry.date_of_capture`` (YYYY-MM-DD) or None.

    With ``greenhouse`` set, returns that greenhouse's absolute latest scout
    date — independent of any dashboard date window or observation filter, so
    the Application Plan header shows the true last scouted day. Without it,
    returns the site-wide latest (used by the map pages to seed date ranges).
    """
    greenhouse = (greenhouse or "").strip()
    if greenhouse:
        row = frappe.db.sql(
            "SELECT MAX(date_of_capture) FROM `tabScouting Entry` WHERE greenhouse=%s",
            (greenhouse,),
        )
    else:
        row = frappe.db.sql(
            "SELECT MAX(date_of_capture) FROM `tabScouting Entry`"
        )
    return str(row[0][0]) if row and row[0] and row[0][0] else None


@frappe.whitelist()
def get_farms_and_warehouses():
    """{farm: [greenhouse_name, ...]} — allowed greenhouses (active only).

    Used by the scouting dashboard to populate the Farm dropdown.
    """
    return get_or_set(
        K_SM_FARMS_AND_WHS,
        scouting_metrics.get_farms_and_warehouses,
        ttl=TTL_MEDIUM,
    )


@frappe.whitelist()
def get_units_by_warehouse():
    """{warehouse: {type: greenhouse, count, farm}} — pressure denominator."""
    return get_or_set(
        K_SM_UNITS_BY_WH,
        scouting_metrics.get_units_by_warehouse,
        ttl=TTL_LONG,
    )


@frappe.whitelist()
def get_crops_with_farms():
    """[{name, crop_name, farms: [...]}] — drives the dashboard Crop filter."""
    return get_or_set(
        K_CROPS_SCOUTED,
        scouting_metrics.get_crops_with_farms,
        ttl=TTL_MEDIUM,
    )


@frappe.whitelist()
def get_severity_thresholds():
    """{crop: {pests: {pest: {unit, low, moderate, high}}, diseases: {...}}}.

    Drives the dashboard pest/disease severity classifier. Cache key is
    invalidated by Crop Scouted / Pest Filter / Disease Filter doc events.
    """
    return get_or_set(
        K_SM_SEVERITY_THRESHOLDS,
        scouting_metrics.get_severity_thresholds,
        ttl=TTL_MEDIUM,
    )


@frappe.whitelist()
def get_beds_by_greenhouse(active_only=1):
    """{greenhouse: [{name, bed, unit_type, variety, bed__area}, ...]}.

    ``active_only`` defaults to 1; pass 0 to include retired beds.
    """
    active_only = bool(int(active_only)) if active_only is not None else True
    if active_only:
        return get_or_set(
            K_SM_BEDS_BY_GH,
            lambda: scouting_metrics.get_beds_by_greenhouse(active_only=True),
            ttl=TTL_LONG,
        )
    # Uncached when the caller explicitly asks for the full list — rare.
    return scouting_metrics.get_beds_by_greenhouse(active_only=False)


@frappe.whitelist()
def get_zones_by_greenhouse():
    """{greenhouse: [{name, bed, zone}, ...]}."""
    return get_or_set(
        K_SM_ZONES_BY_GH,
        scouting_metrics.get_zones_by_greenhouse,
        ttl=TTL_LONG,
    )


@frappe.whitelist()
def get_zone_counts_by_greenhouse():
    """{greenhouse: zone_count}. Denominator for trends/heatmap percentages."""
    from upande_scp.serverscripts.cache_utils import K_SM_ZONE_COUNTS_BY_GH

    return get_or_set(
        K_SM_ZONE_COUNTS_BY_GH,
        scouting_metrics.get_zone_counts_by_greenhouse,
        ttl=TTL_LONG,
    )


_K_SCOUTS_LOOKUP = "scp:sm_scout_lookup_v1"


def _build_scout_lookup():
    """{employee_id: employee_name} for every Employee referenced as a scout.

    The Scouting Entry ``scouts_name`` field stores the Employee's numeric ID
    (e.g. ``"200397"``). We need the readable name for top-scouts widgets.
    """
    rows = frappe.get_all(
        "Employee",
        fields=["name", "employee_name"],
        filters={"status": "Active"},
        limit_page_length=0,
    )
    return {r["name"]: (r.get("employee_name") or r["name"]) for r in rows}


@frappe.whitelist()
def list_tank_mixes(farm=None, q=None, active_only=1, limit=200):
    """List Chemical-Mix BOMs with their exploded chemicals attached.

    Mirrors upande_scp/www/tank_mix_list/index.py so the React port can
    pull the same data over a single round-trip instead of replicating
    the multi-table fetch on the client.
    """
    bom_filters = [["BOM", "custom_item_group", "=", "Chemical Mix"]]
    if str(active_only).strip() in ("1", "true", "yes"):
        bom_filters.append(["BOM", "is_active", "=", 1])
    if farm:
        bom_filters.append(["BOM", "custom_farm", "=", farm])
    if q:
        bom_filters.append(["BOM", "item", "like", f"%{q}%"])

    boms = frappe.get_list(
        "BOM",
        filters=bom_filters,
        fields=[
            "name",
            "item",
            "item_name",
            "custom_farm",
            "custom_business_unit",
            "custom_water_ph",
            "custom_water_hardness",
            "uom",
            "quantity",
            "is_active",
            "is_default",
            "modified",
            "modified_by",
            "owner",
        ],
        order_by="modified desc",
        limit=int(limit) or 200,
    )
    bom_names = [b["name"] for b in boms]
    items_by_bom = {}
    if bom_names:
        rows = frappe.get_all(
            "BOM Explosion Item",
            filters={"parent": ["in", bom_names], "parenttype": "BOM"},
            fields=[
                "parent",
                "item_code",
                "item_name",
                "stock_qty",
                "stock_uom",
                "rate",
                "amount",
                "idx",
            ],
            order_by="parent asc, idx asc",
            limit_page_length=10000,
        )
        for r in rows:
            items_by_bom.setdefault(r["parent"], []).append(r)

    for b in boms:
        b["chemicals"] = items_by_bom.get(b["name"], [])
        b["item_count"] = len(b["chemicals"])
        b["total_amount"] = sum(c.get("amount") or 0 for c in b["chemicals"])
    return {
        "tank_mixes": boms,
        "farms": sorted({b.get("custom_farm") for b in boms if b.get("custom_farm")}),
    }


@frappe.whitelist()
def list_application_work_orders(
    from_date=None,
    to_date=None,
    farm=None,
    greenhouse=None,
    status=None,
    limit=200,
):
    """Application Floor Plan Work Orders for the React Historical page.

    Echoes the server-rendered query in
    upande_scp/www/application_work_order_history/index.py without forcing
    a page reload to change filters.
    """
    from frappe.utils import add_days, getdate, nowdate

    today = getdate(nowdate())
    df = getdate(from_date) if from_date else add_days(today, -30)
    dt = getdate(to_date) if to_date else today

    filters = [
        ["Work Order", "custom_type", "=", "Application Floor Plan"],
        ["Work Order", "custom_scheduled_application_time", ">=", df],
        ["Work Order", "custom_scheduled_application_time", "<=", add_days(dt, 1)],
    ]
    if greenhouse:
        filters.append(["Work Order", "custom_greenhouse", "=", greenhouse])
    s = (status or "").lower()
    if s == "pending":
        filters.append(["Work Order", "docstatus", "=", 0])
    elif s == "approved":
        filters.append(["Work Order", "docstatus", "=", 1])
    elif s == "cancelled":
        filters.append(["Work Order", "docstatus", "=", 2])

    rows = frappe.get_list(
        "Work Order",
        filters=filters,
        fields=[
            "name",
            "production_item",
            "item_name",
            "qty",
            "stock_uom",
            "custom_greenhouse",
            "custom_variety",
            "custom_scope",
            "custom_spray_type",
            "custom_kit",
            "custom_scheduled_application_time",
            "custom_area",
            "docstatus",
            "owner",
            "creation",
        ],
        order_by="custom_scheduled_application_time desc, creation desc",
        limit=int(limit) or 200,
    )
    if farm:
        f_low = farm.lower()
        rows = [
            w for w in rows
            if w.get("custom_greenhouse")
            and (
                w["custom_greenhouse"].split(" - ")[-1] == farm
                or f_low in (w["custom_greenhouse"] or "").lower()
            )
        ]
    for w in rows:
        ds = w.get("docstatus")
        w["status_label"] = (
            "Approved" if ds == 1 else "Cancelled" if ds == 2 else "Pending"
        )
        w["status_state"] = (
            "approved" if ds == 1 else "cancelled" if ds == 2 else "pending"
        )

    ghs = frappe.db.sql(
        """
        SELECT DISTINCT custom_greenhouse
        FROM `tabWork Order`
        WHERE custom_type = 'Application Floor Plan'
          AND custom_greenhouse IS NOT NULL AND custom_greenhouse != ''
        ORDER BY custom_greenhouse
        """,
        as_dict=True,
    )
    farms = sorted({
        (g["custom_greenhouse"] or "").split(" - ")[-1]
        for g in ghs
        if g["custom_greenhouse"]
    })
    return {
        "work_orders": rows,
        "greenhouses": [g["custom_greenhouse"] for g in ghs],
        "farms": [f for f in farms if f],
    }


@frappe.whitelist()
def get_application_work_order(name):
    """Single Application Work Order with its BOM exploded items, used by
    the React detail view."""
    if not name:
        frappe.throw("name is required")
    wo = frappe.get_doc("Work Order", name).as_dict()
    bom = None
    chemicals = []
    if wo.get("bom_no"):
        try:
            bom_doc = frappe.get_doc("BOM", wo["bom_no"])
            bom = bom_doc.as_dict()
            chemicals = [c.as_dict() for c in (bom_doc.exploded_items or [])]
        except frappe.DoesNotExistError:
            pass
    if wo.get("docstatus") == 1:
        status_label, status_state = "Approved", "approved"
    elif wo.get("docstatus") == 2:
        status_label, status_state = "Cancelled", "cancelled"
    else:
        status_label, status_state = "Pending", "pending"
    return {
        "work_order": wo,
        "bom": bom,
        "chemicals": chemicals,
        "status_label": status_label,
        "status_state": status_state,
    }


@frappe.whitelist()
def submit_application_work_order(name):
    """Approve a Work Order from the Approvals page (docstatus 0 → 1)."""
    if not name:
        frappe.throw("name is required")
    doc = frappe.get_doc("Work Order", name)
    if doc.docstatus == 0:
        doc.submit()
    return {"name": doc.name, "docstatus": doc.docstatus}


@frappe.whitelist()
def cancel_application_work_order(name):
    """Cancel a submitted Work Order from the Approvals page."""
    if not name:
        frappe.throw("name is required")
    doc = frappe.get_doc("Work Order", name)
    if doc.docstatus == 1:
        doc.cancel()
    return {"name": doc.name, "docstatus": doc.docstatus}


@frappe.whitelist()
def list_chemical_items(q=None, limit=50):
    """Search Items the planner can add to a BOM — restricted to chemical /
    fertilizer item groups so we don't surface every Item in the company."""
    from upande_scp.serverscripts.get_bom_stock_balances import (
        _FERTILIZER_GROUP,
    )

    filters = [
        ["Item", "disabled", "=", 0],
        ["Item", "item_group", "in", ["Chemicals", _FERTILIZER_GROUP]],
    ]
    if q:
        filters.append(["Item", "item_name", "like", f"%{q}%"])
    rows = frappe.get_all(
        "Item",
        filters=filters,
        fields=["name", "item_name", "stock_uom", "item_group"],
        order_by="item_name asc",
        limit_page_length=int(limit) or 50,
    )
    return [
        {
            "item_code": r["name"],
            "item_name": r["item_name"],
            "stock_uom": r["stock_uom"],
            "item_group": r["item_group"],
            "is_fertilizer": r["item_group"] == _FERTILIZER_GROUP,
        }
        for r in rows
    ]


@frappe.whitelist()
def get_chemical_stock_balances(item_codes):
    """Per-warehouse stock balances for ad-hoc item codes.

    Used by the React Application Plan when the operator adds a chemical
    that isn't part of the BOM's exploded items — without this the row
    would render with empty ``balances`` and every warehouse cell would
    show 0.00 even though the item has real stock.

    Returns ``{item_code: {warehouse: qty}}`` keyed exactly like the
    ``balances`` field inside ``get_bom_details``.
    """
    import json as _json

    if isinstance(item_codes, str):
        try:
            item_codes = _json.loads(item_codes)
        except (TypeError, ValueError):
            item_codes = [c.strip() for c in item_codes.split(",") if c.strip()]
    item_codes = [c for c in (item_codes or []) if c]
    if not item_codes:
        return {}

    from upande_scp.serverscripts.get_bom_stock_balances import (
        _FERTILIZER_GROUP,
        _fill_balances,
        get_allowed_chemical_store_warehouses,
        get_allowed_fertilizer_unit_warehouses,
    )

    groups = dict(
        frappe.db.sql(
            "SELECT name, item_group FROM `tabItem` WHERE name IN %(codes)s",
            {"codes": tuple(item_codes)},
        )
    )
    chem_codes = [c for c in item_codes if groups.get(c) != _FERTILIZER_GROUP]
    fert_codes = [c for c in item_codes if groups.get(c) == _FERTILIZER_GROUP]

    out: dict[str, dict[str, float]] = {}
    if chem_codes:
        out.update(_fill_balances(chem_codes, get_allowed_chemical_store_warehouses()))
    if fert_codes:
        out.update(_fill_balances(fert_codes, get_allowed_fertilizer_unit_warehouses()))
    for code in item_codes:
        out.setdefault(code, {})
    return out


@frappe.whitelist()
def get_bom_details(name):
    """Single BOM with its exploded chemicals + stock balances per warehouse.

    Returned chemicals already carry ``balances`` (warehouse → qty) so the
    React Application Plan can render the source-warehouse pickers without
    a second round-trip. Falls back to chem warehouses only when fertilizer
    balances aren't relevant.
    """
    if not name:
        frappe.throw("name is required")

    from upande_scp.serverscripts.get_bom_stock_balances import (
        _FERTILIZER_GROUP,
    )

    bom = frappe.get_doc("BOM", name)
    chemicals = []
    for it in bom.exploded_items or []:
        item_group = (
            frappe.db.get_value("Item", it.item_code, "item_group") or ""
        )
        chemicals.append({
            "item_code": it.item_code,
            "item_name": it.item_name,
            "stock_qty": it.stock_qty,
            "stock_uom": it.stock_uom,
            "rate": it.rate,
            "amount": it.amount,
            "idx": it.idx,
            "item_group": item_group,
            # Explicit flag so the React picker knows which warehouse list
            # ("Chemical Store" vs "Fertilizer Store") to show. Source of
            # truth lives in get_bom_stock_balances._FERTILIZER_GROUP.
            "is_fertilizer": item_group == _FERTILIZER_GROUP,
        })

    # Stock balances for every chemical the BOM explodes into.
    item_codes = [c["item_code"] for c in chemicals if c.get("item_code")]
    chem_warehouses = []
    fert_warehouses = []
    balances_by_code = {}

    if item_codes:
        from upande_scp.serverscripts.get_bom_stock_balances import (
            _FERTILIZER_GROUP,
            _fill_balances,
            get_allowed_chemical_store_warehouses,
            get_allowed_fertilizer_unit_warehouses,
        )

        chem_warehouses = get_allowed_chemical_store_warehouses()
        fert_warehouses = get_allowed_fertilizer_unit_warehouses()

        chem_codes = [c["item_code"] for c in chemicals if c.get("item_group") != _FERTILIZER_GROUP]
        fert_codes = [c["item_code"] for c in chemicals if c.get("item_group") == _FERTILIZER_GROUP]

        if chem_codes:
            balances_by_code.update(_fill_balances(chem_codes, chem_warehouses))
        if fert_codes:
            balances_by_code.update(_fill_balances(fert_codes, fert_warehouses))

    for c in chemicals:
        c["balances"] = balances_by_code.get(c["item_code"], {})

    return {
        "name": bom.name,
        "item_name": bom.item_name,
        "uom": bom.uom,
        "quantity": bom.quantity,
        "custom_water_ph": bom.get("custom_water_ph"),
        "custom_water_hardness": bom.get("custom_water_hardness"),
        "custom_water_volume": bom.get("custom_water_volume"),
        "custom_farm": bom.get("custom_farm"),
        "custom_business_unit": bom.get("custom_business_unit"),
        "chemicals": chemicals,
        "chemical_warehouses": chem_warehouses,
        "fertilizer_warehouses": fert_warehouses,
    }


@frappe.whitelist()
def get_application_plan_bootstrap():
    """One-shot bootstrap for the React Application Plan page.

    Returns:
        warehouses:   greenhouses allowed for spray plans (filtered by Spray
                      Plan Settings allowed-farms + spray equipment registry).
        kits:         Spray Equipment Details rows ({kit, warehouse}).
        boms:         Active Chemical Mix BOMs the planner can pick from.
        spray_teams:  Names of enabled Spray Team rows — populates the
                      ``custom_spray_team`` dropdown in the React plan
                      page (legacy field on the Application Floor Plan).
    """
    from upande_scp.serverscripts.cache_utils import (
        K_AFP_WAREHOUSES,
        K_AFP_SPRAY_EQUIPMENT,
        TTL_LONG,
    )

    def _build_warehouses():
        # Use the exact same filter as new_application_floor_plan/index.py:
        # Spray Plan Settings allowed_farms + the GH-name regex + exclude
        # keywords. Keeps the React greenhouse list aligned with the JS one.
        from upande_scp.www.new_application_floor_plan.index import (
            _build_warehouses as _build_afp_warehouses,
        )

        return _build_afp_warehouses()

    def _build_kits():
        return frappe.get_all(
            "Spray Equipment Details",
            fields=["kit", "warehouse"],
            limit_page_length=0,
        )

    spray_teams = [
        r.name
        for r in frappe.get_all(
            "Spray Team",
            filters={"enabled": 1},
            fields=["name"],
            order_by="name asc",
            limit_page_length=0,
        )
    ]

    return {
        "warehouses": get_or_set(K_AFP_WAREHOUSES, _build_warehouses, ttl=TTL_LONG),
        "kits": get_or_set(K_AFP_SPRAY_EQUIPMENT, _build_kits, ttl=TTL_LONG),
        "boms": frappe.get_all(
            "BOM",
            filters={
                "custom_item_group": "Chemical Mix",
                "is_active": 1,
                "docstatus": 1,
            },
            fields=["name", "item_name", "custom_farm", "uom", "quantity"],
            order_by="modified desc",
            limit_page_length=200,
        ),
        "spray_teams": spray_teams,
    }


@frappe.whitelist()
def get_scout_lookup():
    """Map of Employee ``name`` (the numeric ID) to human-readable
    ``employee_name``. Cached because the Employee list rarely changes during
    a session and Top Scouts panels render on every dashboard load."""
    return get_or_set(_K_SCOUTS_LOOKUP, _build_scout_lookup, ttl=TTL_LONG)


@frappe.whitelist()
def get_traps_by_greenhouse(trap_type=None):
    """{greenhouse: {"indoor": [...], "outdoor": [...]}}.

    ``trap_type`` — pass "FCM" to restrict to FCM traps.
    """
    if trap_type:
        # Don't cache per-type variants; cheap enough to recompute.
        return scouting_metrics.get_traps_by_greenhouse(trap_type=trap_type)
    return get_or_set(
        K_SM_TRAPS_BY_GH,
        scouting_metrics.get_traps_by_greenhouse,
        ttl=TTL_MEDIUM,
    )
