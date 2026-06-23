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
K_BLOCKS_GEOJSON = "scp:blocks_geojson_v1"
K_FARMS_AND_GREENHOUSES = "scp:farms_and_greenhouses_v1"
K_AFP_WAREHOUSES = "scp:afp_warehouses_v3"
K_AFP_SPRAY_EQUIPMENT = "scp:afp_spray_equipment_v1"
K_CHEMICALS_LIST = "scp:chemicals_list_v2"
K_SM_FARMS_AND_GHS = "scp:sm_farms_and_ghs_v1"
K_SM_BEDS_BY_GH = "scp:sm_beds_by_gh_v1"
K_SM_ZONES_BY_GH = "scp:sm_zones_by_gh_v1"
K_SM_ZONE_COUNTS_BY_GH = "scp:sm_zone_counts_by_gh_v1"
K_SM_UNITS_BY_WH = "scp:sm_units_by_wh_v1"
K_SM_FARMS_AND_WHS = "scp:sm_farms_and_whs_v1"
K_SM_SEVERITY_THRESHOLDS = "scp:sm_severity_thresholds_v1"
K_SM_TRAPS_BY_GH = "scp:sm_traps_by_gh_v1"
# Per-farm bulk bundle for the mobile configure flow. Key is suffixed with
# the farm name: "scp:sm_farm_bundle_v1:{farm}". Holds all warehouses +
# beds + traps + sections for a farm so the mobile app can populate its
# offline cache in a single request instead of per-block round-trips.
K_SM_FARM_BUNDLE_PREFIX = "scp:sm_farm_bundle_v1"
# Per-block Orchard Tree FeatureCollection used by the avocado view of the
# scouts map. Key suffix is the block (Warehouse) name.
K_ORCHARD_TREES_PREFIX = "scp:orchard_trees_v1"
# Per-farm Tank & Valve FeatureCollection for the avocado 3D map. Suffix is
# the farm name (or '__all__' for the unfiltered bundle).
K_TANKS_VALVES_PREFIX = "scp:tanks_valves_v1"
K_CROPS_SCOUTED = "scp:crops_scouted_v1"
# Pest / Plant Disease legend colours (the per-name hex stored on the
# doctype). Cached separately from the heavy scouting payload so a colour
# tweak invalidates instantly without rebuilding the per-month entries.
K_PEST_COLORS = "scouting_dashboard:pest_colors"
K_DISEASE_COLORS = "scouting_dashboard:disease_colors"
# Map Settings — global default lat/lon/zoom + per-farm coordinates that
# the SPA uses to fly-to a farm when the operator picks one in the
# Traps / Observations / Rose Scouting headers.
K_MAP_SETTINGS = "scp:map_settings_v1"
# Cascading Farm → Section → Block/Greenhouse hierarchy for the scouts map.
K_FARM_HIERARCHY = "scp:farm_hierarchy_v1"
# Versioned scouting payload cache. Keys use the prefix + version stamp +
# args, so invalidation is O(1): bump the stamp and old keys orphan via TTL.
K_SCOUTING_PAYLOAD_PREFIX  = "scp:scouting_payload_v2"
K_SCOUTING_PAYLOAD_VERSION = "scp:scouting_payload_ver_v2"
# One-centroid-per-Zone payload for the rose 3D map. Invalidated by Zone
# create/update/delete (the geometry source of truth) and Bed/Warehouse
# changes (which can rename or reparent zones).
K_ZONE_CENTROIDS = "scp:zone_centroids_v1"


def scouting_payload_version():
    """Current version stamp for the scouting payload cache namespace.

    Used as part of the cache key so we can invalidate everything by simply
    bumping the stamp — old keys orphan and TTL-out.
    """
    cache = frappe.cache()
    v = cache.get_value(K_SCOUTING_PAYLOAD_VERSION)
    if v is None:
        v = 1
        cache.set_value(K_SCOUTING_PAYLOAD_VERSION, v)
    return v


def invalidate_scouting_payload():
    """Bump the version so every cached scouting payload becomes a miss."""
    cache = frappe.cache()
    v = cache.get_value(K_SCOUTING_PAYLOAD_VERSION) or 1
    cache.set_value(K_SCOUTING_PAYLOAD_VERSION, int(v) + 1)


def _resolve_scouting_date(doc):
    """Best-effort ``datetime.date`` of capture for a scouting-related doc.

    Parent rows carry ``date_of_capture`` directly; child rows walk to their
    parent. Returns ``None`` when it can't be resolved (e.g. the parent was
    deleted in the same transaction) so callers can fall back to a global bump.
    """
    from datetime import date, datetime

    dt = getattr(doc, "doctype", None)
    raw = None
    if dt == "Scouting Entry":
        raw = getattr(doc, "date_of_capture", None)
    elif dt in ("Pests Scouting Entry", "Diseases Scouting Entry", "Trap Scouting Entry"):
        parent = getattr(doc, "parent", None)
        if parent:
            raw = frappe.db.get_value("Scouting Entry", parent, "date_of_capture")
    if not raw:
        return None
    if isinstance(raw, datetime):
        return raw.date()
    if isinstance(raw, date):
        return raw
    try:
        return datetime.strptime(str(raw)[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def invalidate_scouting_week(iso_year, iso_week):
    """Delete the cached payload for a single ISO week at the current version."""
    v = scouting_payload_version()
    key = f"{K_SCOUTING_PAYLOAD_PREFIX}:{v}:{iso_year:04d}-W{iso_week:02d}"
    invalidate(key)


def invalidate_scouting_week_for_doc(doc):
    """Bust only the ISO week a scouting write touches, not the whole cache.

    The previous behaviour bumped a global version stamp on every Scouting
    Entry write, which cold-cached *every* week at once. During active
    scouting that meant the next map open rebuilt a full week (~100k rows on
    the live site) from SQL. Here we delete only the affected week's key so
    historical weeks stay warm and only the week being scouted ever rebuilds.

    Falls back to the global version bump when the week can't be resolved.

    Note: editing a Scouting Entry's ``date_of_capture`` across an ISO-week
    boundary only busts the new week here; the old week's slice self-heals on
    its TTL (TTL_MEDIUM). Such edits are rare, so we don't pay the cost of
    resolving the pre-save date on every write.
    """
    d = _resolve_scouting_date(doc)
    if not d:
        invalidate_scouting_payload()
        return
    iso = d.isocalendar()
    invalidate_scouting_week(iso[0], iso[1])


def _resolve_scouting_month(doc):
    """Best-effort YYYY-MM string for a scouting-related doc.

    Parent rows carry ``date_of_capture`` directly. Child rows (Pests/Diseases/
    Trap Scouting Entry) walk to their parent. Other doctypes that bust the
    payload cache (Zone, Bed, Warehouse, Farm, Orchard Tree) don't have a
    natural month — return ``None`` so the client treats them as a global
    invalidation."""
    dt = getattr(doc, "doctype", None)
    if dt == "Scouting Entry":
        d = getattr(doc, "date_of_capture", None)
        return str(d)[:7] if d else None
    if dt in ("Pests Scouting Entry", "Diseases Scouting Entry", "Trap Scouting Entry"):
        parent = getattr(doc, "parent", None)
        if not parent:
            return None
        d = frappe.db.get_value("Scouting Entry", parent, "date_of_capture")
        return str(d)[:7] if d else None
    return None


def publish_scouting_dirty(doc, method=None):
    """Realtime nudge so listening clients re-run their delta sync.

    Payload shape:
        { months: ["YYYY-MM"] | [] }   (empty list = global invalidation)

    Channel ``scp:scouting:dirty`` is broadcast site-wide; permission scoping
    happens client-side because the message contains no row data — only a hint
    that *something* changed.
    """
    try:
        month = _resolve_scouting_month(doc)
        frappe.publish_realtime(
            event="scp:scouting:dirty",
            message={"months": [month] if month else []},
            after_commit=True,
        )
    except Exception:
        # Never let a realtime failure break the underlying write.
        frappe.log_error(
            f"publish_scouting_dirty failed for {getattr(doc, 'doctype', '?')}",
            "SCP Realtime",
        )


def invalidate_farm_bundle(farm):
    """Clear the cached farm bundle for one farm."""
    if not farm:
        return
    invalidate(f"{K_SM_FARM_BUNDLE_PREFIX}:{farm}")


def invalidate_orchard_trees_for_block(block):
    if not block:
        return
    invalidate(f"{K_ORCHARD_TREES_PREFIX}:{block}")


def invalidate_tanks_valves_for_doc(doc):
    """Drop both the doc's farm key and the unfiltered bundle."""
    farm = getattr(doc, "farm", None)
    invalidate(f"{K_TANKS_VALVES_PREFIX}:__all__")
    if farm:
        invalidate(f"{K_TANKS_VALVES_PREFIX}:{farm}")


def invalidate_orchard_trees_for_doc(doc):
    """Invalidate the cached tree FeatureCollection for the doc's block.

    Resolves the block from `doc.block` first, then via the row's greenhouse
    when block is missing (e.g. on insert before before_save fires). Also
    drops the per-farm key so the farm-wide tree map rebuilds.
    """
    block = getattr(doc, "block", None)
    if not block:
        row = getattr(doc, "row", None)
        if row:
            block = frappe.db.get_value("Bed", row, "greenhouse")
    invalidate_orchard_trees_for_block(block)
    if block:
        farm = frappe.db.get_value("Warehouse", block, "custom_farm")
        if farm:
            invalidate(f"{K_ORCHARD_TREES_PREFIX}:farm:{farm}")


def invalidate_farm_bundle_for_doc(doc):
    """Resolve the farm from a doc and invalidate that farm's bundle.

    Used by the doc_event hook when Bed / Trap / Warehouse / Farm records
    change. Falls back to a no-op when the farm cannot be resolved (rather
    than nuking every farm's cache).
    """
    farm = None
    dt = getattr(doc, "doctype", None)
    if dt == "Farm":
        farm = doc.name
    elif dt == "Warehouse":
        farm = getattr(doc, "custom_farm", None)
    elif dt == "Trap":
        farm = getattr(doc, "farm", None)
    elif dt == "Bed":
        gh = getattr(doc, "greenhouse", None)
        if gh:
            farm = frappe.db.get_value("Warehouse", gh, "custom_farm")
    invalidate_farm_bundle(farm)


# ── Builders (canonical queries used across endpoints) ─────────────────────


def _stage_icon_map():
    """{stage_name: icon_key} from the Stage catalog. Each stage's symbol is
    defined once on Stage; readers resolve it by the stage name they link to."""
    return {
        s.name: (s.icon_key or "")
        for s in frappe.get_all("Stage", fields=["name", "icon_key"], limit_page_length=0)
    }


def _build_pests_group():
    """Pests with stages aggregated from every Crop Scouted's Pest Filter rows.

    Stages now live per-crop on Pest Filter. For the global cache view we
    de-duplicate by stage name across crops so the heatmap legend keeps
    showing every stage a pest may carry on any crop.
    """
    icons = _stage_icon_map()
    pests = frappe.get_all(
        "Pest",
        fields=["name", "common_name", "pests_legend_color"],
    )
    if not pests:
        return {}

    filter_rows = frappe.get_all(
        "Pest Filter",
        fields=["name", "pest"],
        limit_page_length=0,
    )
    if not filter_rows:
        return {
            (p.common_name or p.name): {
                "color": p.pests_legend_color or "#999999",
                "stages": [],
            }
            for p in pests
        }

    row_to_pest = {r.name: r.pest for r in filter_rows}

    stage_rows = frappe.get_all(
        "Pests Stages",
        filters={
            "parent": ["in", list(row_to_pest.keys())],
            "parenttype": "Pest Filter",
        },
        fields=["parent", "stage", "reading_type"],
        limit_page_length=0,
    )

    stages_by_pest = {}
    seen = set()  # (pest_name, stage_name) — dedupe across crops
    for s in stage_rows:
        pest_name = row_to_pest.get(s.parent)
        if not pest_name or not s.stage:
            continue
        key = (pest_name, s.stage)
        if key in seen:
            continue
        seen.add(key)
        icon = icons.get(s.stage, "")
        stages_by_pest.setdefault(pest_name, []).append({
            "stage": s.stage,
            "reading_type": s.reading_type,
            "icon_key": icon,
            "symbol": icon,  # legacy alias; value is now the Stage icon_key
        })

    return {
        (p.common_name or p.name): {
            "color": p.pests_legend_color or "#999999",
            "stages": stages_by_pest.get(p.name, []),
        }
        for p in pests
    }


def _build_diseases_group():
    """Diseases with stages aggregated from every Crop Scouted's Disease Filter
    rows (parity with pests). De-duplicated by stage name across crops."""
    icons = _stage_icon_map()
    diseases = frappe.get_all(
        "Plant Disease",
        fields=["name", "common_name", "disease_legend_color"],
    )
    if not diseases:
        return {}

    filter_rows = frappe.get_all(
        "Disease Filter",
        fields=["name", "disease"],
        limit_page_length=0,
    )
    row_to_disease = {r.name: r.disease for r in filter_rows}

    stages_by_disease = {}
    if row_to_disease:
        seen = set()  # (disease_name, stage_name) — dedupe across crops
        for s in frappe.get_all(
            "Disease Stages",
            filters={"parent": ["in", list(row_to_disease.keys())], "parenttype": "Disease Filter"},
            fields=["parent", "stage", "reading_type"],
            limit_page_length=0,
        ):
            disease_name = row_to_disease.get(s.parent)
            if not disease_name or not s.stage:
                continue
            key = (disease_name, s.stage)
            if key in seen:
                continue
            seen.add(key)
            icon = icons.get(s.stage, "")
            stages_by_disease.setdefault(disease_name, []).append({
                "stage": s.stage,
                "reading_type": s.reading_type,
                "icon_key": icon,
                "symbol": icon,  # legacy alias; value is now the Stage icon_key
            })

    return {
        (d.common_name or d.name): {
            "color": d.disease_legend_color or "#999999",
            "stages": stages_by_disease.get(d.name, []),
        }
        for d in diseases
    }


def build_observation_types():
    """Return color + stages for every observation doctype.

    Flat single query per stages child table — no per-master get_doc.
    """
    def _build_group(master_doctype, color_field, stage_table, has_symbol):
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
        "pests": _build_pests_group(),
        "diseases": _build_diseases_group(),
        "predators": _build_group("Predator", None, "Predator Stages", False),
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
    "Employee": ("scp:sm_scout_lookup_v1",),
    "Pest": (K_OBSERVATION_TYPES, K_PEST_COLORS),
    "Plant Disease": (K_OBSERVATION_TYPES, K_DISEASE_COLORS),
    "Predator": (K_OBSERVATION_TYPES,),
    "Weed": (K_OBSERVATION_TYPES,),
    "Incident": (K_OBSERVATION_TYPES,),
    "Physiological Disorder": (K_OBSERVATION_TYPES,),
    "Pests Stages": (K_OBSERVATION_TYPES,),
    "Disease Stages": (K_OBSERVATION_TYPES,),
    "Predator Stages": (K_OBSERVATION_TYPES,),
    "Zone": (K_ZONES_GEOJSON, K_ZONE_COUNT_BY_BED, K_BEDS_AND_ZONES, K_SM_ZONES_BY_GH, K_SM_ZONE_COUNTS_BY_GH, K_SM_UNITS_BY_WH, K_ZONE_CENTROIDS),
    "Bed": (K_ZONE_COUNT_BY_BED, K_BED_COUNT_BY_GH, K_BEDS_AND_ZONES, K_SM_BEDS_BY_GH, K_ZONE_CENTROIDS),
    "Warehouse": (K_GREENHOUSES_GEOJSON, K_BLOCKS_GEOJSON, K_FARMS_AND_GREENHOUSES, K_AFP_WAREHOUSES, K_SM_FARMS_AND_GHS, K_SM_FARMS_AND_WHS, K_SM_UNITS_BY_WH, K_FARM_HIERARCHY, K_ZONE_CENTROIDS),
    "Farm": (K_FARMS_AND_GREENHOUSES, K_SM_FARMS_AND_GHS, K_SM_FARMS_AND_WHS, K_FARM_HIERARCHY),
    "Orchard Tree": (K_SM_UNITS_BY_WH,),
    "Trap": (K_SM_TRAPS_BY_GH,),
    "Spray Equipment Details": (K_AFP_SPRAY_EQUIPMENT,),
    "Item": (K_CHEMICALS_LIST,),
    "Crop Scouted": (K_CROPS_SCOUTED, K_SM_SEVERITY_THRESHOLDS),
    "Pest Filter": (K_OBSERVATION_TYPES, K_SM_SEVERITY_THRESHOLDS),
    "Disease Filter": (K_OBSERVATION_TYPES, K_SM_SEVERITY_THRESHOLDS),
    "Tank And Valve": (),
    "Spray Plan Settings": (K_AFP_WAREHOUSES,),
    "Spray Plan Allowed Farm": (K_AFP_WAREHOUSES,),
    "Spray Plan Exclude Keyword": (K_AFP_WAREHOUSES,),
    # The new_application_floor_plan greenhouse picker fuzzy-resolves the
    # Cost Center for warehouses where `custom_cost_center` is still empty,
    # so a new/renamed Cost Center should bust the cached warehouse list
    # AND the cached picker options.
    "Cost Center": (K_AFP_WAREHOUSES, "scp:afp_cost_centers_v1"),
    "Map Settings": (K_MAP_SETTINGS,),
    "Farm Map Coordinate": (K_MAP_SETTINGS,),
}


# High-frequency scouting writes — bust only the affected ISO week.
_SCOUTING_ENTRY_FAMILY = {
    "Scouting Entry",
    "Pests Scouting Entry",
    "Diseases Scouting Entry",
    "Trap Scouting Entry",
}

# Master data that changes the denominator (zone/tree counts) or the
# farm/station mapping. These are rare and can shift many weeks at once, so
# they keep the cheap global version bump.
_SCOUTING_PAYLOAD_INVALIDATORS = {
    *_SCOUTING_ENTRY_FAMILY,
    "Zone",
    "Bed",
    "Warehouse",
    "Farm",
    "Orchard Tree",
}


def invalidate_on_change(doc, method=None):
    keys = _DOC_INVALIDATIONS.get(doc.doctype)
    if keys:
        invalidate(*keys)
    # Also drop the per-farm bundle when the underlying records change so
    # the mobile bundle endpoint rebuilds on next request.
    if doc.doctype in ("Bed", "Trap", "Warehouse", "Farm"):
        invalidate_farm_bundle_for_doc(doc)
    # Drop the per-block Orchard Tree FeatureCollection when trees move.
    if doc.doctype == "Orchard Tree":
        invalidate_orchard_trees_for_doc(doc)
    # Drop the per-farm Tank & Valve bundle when assets move or get edited.
    if doc.doctype == "Tank And Valve":
        invalidate_tanks_valves_for_doc(doc)
    # Scouting writes: bust only the affected ISO week so other weeks stay
    # warm during active scouting. Master-data changes that shift derived
    # denominators across many weeks fall through to the global version bump.
    if doc.doctype in _SCOUTING_ENTRY_FAMILY:
        invalidate_scouting_week_for_doc(doc)
    elif doc.doctype in _SCOUTING_PAYLOAD_INVALIDATORS:
        invalidate_scouting_payload()
