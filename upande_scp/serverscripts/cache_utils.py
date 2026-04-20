"""Shared Redis cache helpers for www dashboards and maps.

Each cache key has a TTL fallback plus a doc-event invalidator registered in
hooks.py. Reads are single Redis round-trips; writes only happen when the
underlying master data changes (Pest / Plant Disease / Zone / Bed / Warehouse / etc.).
"""

import frappe


TTL_SHORT = 300        # 5 min  — lightly-changing aggregates
TTL_MEDIUM = 3600      # 1 hr   — master metadata (pests, diseases…)
TTL_LONG = 86400       # 24 hr  — geometry (zone/bed GeoJSON)


def get_or_set(key, builder, ttl=TTL_MEDIUM):
    """Redis-cached wrapper. builder() is called only on miss."""
    cache = frappe.cache()
    value = cache.get_value(key)
    if value is None:
        value = builder()
        cache.set_value(key, value, expires_in_sec=ttl)
    return value


def invalidate(*keys):
    cache = frappe.cache()
    for key in keys:
        cache.delete_value(key)


# ── Keys (kept central so invalidation hooks can find them) ────────────────

K_OBSERVATION_TYPES = "scp:observation_types_v1"
K_ZONES_GEOJSON = "scp_zone_geojson"
K_ZONE_COUNT_BY_BED = "scp:zone_count_by_bed_v1"
K_BED_COUNT_BY_GH = "scp:bed_count_by_gh_v1"
K_BEDS_AND_ZONES = "scp:beds_and_zones_payload_v1"
K_GREENHOUSES_GEOJSON = "scp:greenhouses_geojson_v1"
K_FARMS_AND_GREENHOUSES = "scp:farms_and_greenhouses_v1"
K_AFP_WAREHOUSES = "scp:afp_warehouses_v1"
K_AFP_SPRAY_EQUIPMENT = "scp:afp_spray_equipment_v1"
K_CHEMICALS_LIST = "scp:chemicals_list_v1"


# ── Builders (canonical queries used across endpoints) ─────────────────────


def build_observation_types():
    """Return color + stages for every observation doctype.

    Flat single query per stages child table — no per-master get_doc.
    """
    def _build_group(master_doctype, color_field, stage_table, stage_parent_field, has_symbol):
        masters = frappe.get_all(
            master_doctype,
            fields=["name", "common_name", color_field] if color_field else ["name", "common_name"],
        )
        stage_fields = ["parent", "stage", "reading_type"]
        if has_symbol:
            stage_fields.insert(2, "symbol")
        stages = frappe.get_all(
            stage_table,
            filters={"parent": ["in", [m.name for m in masters]]} if masters else {"parent": ""},
            fields=stage_fields,
            limit_page_length=0,
        )
        stages_by_parent = {}
        for s in stages:
            entry = {"stage": s.stage, "reading_type": s.reading_type}
            entry["symbol"] = s.get("symbol", "") if has_symbol else ""
            stages_by_parent.setdefault(s.parent, []).append(entry)

        out = {}
        for m in masters:
            label = m.common_name or m.name
            color = m.get(color_field) if color_field else None
            out[label] = {
                "color": color or "#999999",
                "stages": stages_by_parent.get(m.name, []),
            }
        return out

    observation_types = {
        "pests": _build_group("Pest", "pests_legend_color", "Pests Stages", "parent", True),
        "diseases": _build_group("Plant Disease", "disease_legend_color", "Disease Stages", "parent", True),
        "predators": _build_group("Predator", None, "Predator Stages", "parent", False),
        "weeds": {},
        "incidents": {},
        "physiological_disorders": {},
    }

    # Static groups — no stages, just names
    for row in frappe.get_all("Weed", fields=["name"]):
        observation_types["weeds"][row.name] = {"color": "#51cf66", "stages": []}
    for row in frappe.get_all("Incident", fields=["name"]):
        observation_types["incidents"][row.name] = {"color": "#868e96", "stages": []}
    for row in frappe.get_all("Physiological Disorder", fields=["name"]):
        observation_types["physiological_disorders"][row.name] = {"color": "#ff6b6b", "stages": []}

    # Predators: the legacy API always returned a blue swatch
    for label in observation_types["predators"]:
        observation_types["predators"][label]["color"] = "#4c6ef5"

    return observation_types


def build_zone_count_by_bed():
    """{bed_name: zone_count} — only active greenhouses."""
    rows = frappe.db.sql(
        """
        SELECT bed, COUNT(*) AS zone_count
        FROM `tabZone`
        WHERE bed IS NOT NULL AND bed != ''
        GROUP BY bed
        """,
        as_dict=True,
    )
    return {r.bed: r.zone_count for r in rows}


def build_bed_count_by_gh():
    rows = frappe.db.sql(
        """
        SELECT greenhouse, COUNT(*) AS bed_count
        FROM `tabBed`
        WHERE custom_active = 1 AND greenhouse IS NOT NULL AND greenhouse != ''
        GROUP BY greenhouse
        """,
        as_dict=True,
    )
    return {r.greenhouse: r.bed_count for r in rows}


# ── Invalidator dispatch (called from hooks.py doc_events) ─────────────────


_DOC_INVALIDATIONS = {
    "Pest": (K_OBSERVATION_TYPES,),
    "Plant Disease": (K_OBSERVATION_TYPES,),
    "Predator": (K_OBSERVATION_TYPES,),
    "Weed": (K_OBSERVATION_TYPES,),
    "Incident": (K_OBSERVATION_TYPES,),
    "Physiological Disorder": (K_OBSERVATION_TYPES,),
    "Pests Stages": (K_OBSERVATION_TYPES,),
    "Disease Stages": (K_OBSERVATION_TYPES,),
    "Predator Stages": (K_OBSERVATION_TYPES,),
    "Zone": (K_ZONES_GEOJSON, K_ZONE_COUNT_BY_BED, K_BEDS_AND_ZONES),
    "Bed": (K_ZONE_COUNT_BY_BED, K_BED_COUNT_BY_GH, K_BEDS_AND_ZONES),
    "Warehouse": (K_GREENHOUSES_GEOJSON, K_FARMS_AND_GREENHOUSES, K_AFP_WAREHOUSES),
    "Farm": (K_FARMS_AND_GREENHOUSES,),
    "Spray Equipment Details": (K_AFP_SPRAY_EQUIPMENT,),
    "Item": (K_CHEMICALS_LIST,),
}


def invalidate_on_change(doc, method=None):
    keys = _DOC_INVALIDATIONS.get(doc.doctype)
    if keys:
        invalidate(*keys)
