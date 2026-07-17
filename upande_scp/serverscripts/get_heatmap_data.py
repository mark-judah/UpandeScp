import re

import frappe
from frappe import _

from upande_scp.serverscripts.cache_utils import (
    K_BED_COUNT_BY_GH,
    K_FARMS_AND_GREENHOUSES,
    K_OBSERVATION_TYPES,
    K_ZONE_COUNT_BY_BED,
    K_ZONES_GEOJSON,
    TTL_LONG,
    TTL_MEDIUM,
    TTL_SHORT,
    build_bed_count_by_gh,
    build_observation_types,
    build_zone_count_by_bed,
    get_or_set,
)


def _build_zones_geojson():
    """All zones with raw_geojson — cached, filtered per-greenhouse downstream."""
    return frappe.get_all(
        "Zone",
        filters={"geojson": ["is", "set"]},
        fields=["name", "greenhouse", "geojson as raw_geojson"],
        limit_page_length=0,
    )


_BED_NUM_RE = re.compile(r"Bed\s+(\d+)", re.IGNORECASE)


# Maps Scouting Entry child-table → (doctype, item-field on row, extra fields, output key)
_CHILD_TABLE_CONFIG = (
    ("Pests Scouting Entry",        "pest",                     ("stage", "count", "plant_section"), "pests_scouting_entry"),
    ("Diseases Scouting Entry",     "disease",                  ("stage", "plant_section"),          "diseases_scouting_entry"),
    ("Predators Scouting Entry",    "predator",                 ("stage", "count", "plant_section"), "predators_scouting_entry"),
    ("Weeds Scouting Entry",        "weed",                     (),                                   "weeds_scouting_entry"),
    ("Incidents Scouting Entry",    "incident",                 (),                                   "incidents_scouting_entry"),
    ("Physiological Disorders Entry", "physiological_disorders", (),                                  "physiological_disorders_entry"),
)


@frappe.whitelist()
def getHeatmapData(date, greenhouse):
    """Heatmap payload for a single (date, greenhouse).

    Hot path is three queries + Redis hits:
      1) Scouting entries for the day
      2) Parent-IN batched fetch of each child table
      3) Cached observation-type metadata + cached zone-count-by-bed / bed-count-by-gh
    """
    try:
        scouting_entries = frappe.get_all(
            "Scouting Entry",
            filters={"date_of_capture": date, "greenhouse": greenhouse},
            fields=["name", "zone", "bed", "greenhouse"],
            limit_page_length=0,
        )

        bed_count_map = get_or_set(K_BED_COUNT_BY_GH, build_bed_count_by_gh, ttl=TTL_SHORT)
        zone_count_by_bed = get_or_set(K_ZONE_COUNT_BY_BED, build_zone_count_by_bed, ttl=TTL_SHORT)

        bed_count = bed_count_map.get(greenhouse, 0)

        # Max zone-count across beds of this greenhouse — derived from cached map
        gh_beds = frappe.get_all(
            "Bed",
            filters={"greenhouse": greenhouse, "custom_active": 1},
            fields=["name"],
            limit_page_length=0,
        )
        max_zone_count = max(
            (zone_count_by_bed.get(b.name, 0) for b in gh_beds),
            default=0,
        )

        # {bed_number: zone_count} — drives per-bed line lengths in the
        # landscape view, so non-rectangular greenhouses render with their
        # natural stepped silhouette instead of a forced rectangle.
        zone_count_by_bed_num = {}
        for b in gh_beds:
            m = _BED_NUM_RE.search(b.name or "")
            if not m:
                continue
            zone_count_by_bed_num[int(m.group(1))] = zone_count_by_bed.get(b.name, 0)

        observation_types = get_or_set(K_OBSERVATION_TYPES, build_observation_types, ttl=TTL_MEDIUM)

        # Zone polygons drive the floor-plan rendering on the client. Cached
        # once across all greenhouses; we filter to the active greenhouse here
        # so the per-card payload stays small for irregular footprints
        # (double-bed / split-aisle houses parse out as multi-line features).
        all_zone_geojson = get_or_set(K_ZONES_GEOJSON, _build_zones_geojson, ttl=TTL_LONG)
        zone_geojson = [
            {"name": z["name"], "raw_geojson": z["raw_geojson"]}
            for z in all_zone_geojson
            if z.get("greenhouse") == greenhouse
        ]

        if not scouting_entries:
            return {
                "scouting_entries": [],
                "observation_types": observation_types,
                "bed_count": bed_count,
                "zone_count": max_zone_count,
                "zone_count_by_bed": zone_count_by_bed_num,
                "zone_geojson": zone_geojson,
                "message": "No scouting entries found for this date and greenhouse",
            }

        entry_names = [e.name for e in scouting_entries]

        # Seed per-entry buckets in a single pass
        entries_by_name = {}
        for e in scouting_entries:
            entries_by_name[e.name] = {
                "name": e.name,
                "zone": e.zone,
                "bed": e.bed,
                "greenhouse": e.greenhouse,
                "pests_scouting_entry": [],
                "diseases_scouting_entry": [],
                "predators_scouting_entry": [],
                "weeds_scouting_entry": [],
                "incidents_scouting_entry": [],
                "physiological_disorders_entry": [],
            }

        # One batched fetch per child table — no per-entry get_doc
        for child_doctype, item_field, extra_fields, out_key in _CHILD_TABLE_CONFIG:
            fields = ["parent", item_field] + list(extra_fields)
            rows = frappe.get_all(
                child_doctype,
                filters={"parent": ["in", entry_names]},
                fields=fields,
                limit_page_length=0,
            )
            for row in rows:
                bucket = entries_by_name.get(row.parent)
                if not bucket:
                    continue
                obs = {"name": row.get(item_field)}
                for f in extra_fields:
                    obs[f] = row.get(f) if f != "count" else (row.get(f) or 0)
                bucket[out_key].append(obs)

        return {
            "scouting_entries": list(entries_by_name.values()),
            "observation_types": observation_types,
            "bed_count": bed_count,
            "zone_count": max_zone_count,
            "zone_count_by_bed": zone_count_by_bed_num,
            "zone_geojson": zone_geojson,
            "date": date,
            "greenhouse": greenhouse,
        }

    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Get Heatmap Data Error")
        frappe.throw(_("Error fetching heatmap data: {0}").format(str(e)))


@frappe.whitelist()
def getFarmsAndGreenhouses():
    """Farms grouped by greenhouse — cached, single pass."""
    try:
        def _build():
            farms = frappe.get_all("Farm", fields=["name", "farm_name as farm"], order_by="farm_name asc")
            greenhouses = frappe.get_all(
                "Warehouse",
                filters={"warehouse_type": "Greenhouse"},
                fields=["name", "warehouse_name", "custom_farm"],
                order_by="name asc",
                limit_page_length=0,
            )
            farms_data = {f.farm: {"name": f.farm, "greenhouses": []} for f in farms}
            for gh in greenhouses:
                fname = gh.custom_farm
                if fname and fname in farms_data:
                    farms_data[fname]["greenhouses"].append({
                        "name": gh.name,
                        "warehouse_name": gh.warehouse_name,
                    })
            return {
                "farms": [
                    {"name": fname, "greenhouses": data["greenhouses"]}
                    for fname, data in farms_data.items()
                    if data["greenhouses"]
                ]
            }

        return get_or_set(K_FARMS_AND_GREENHOUSES, _build, ttl=TTL_MEDIUM)

    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Get Farms and Greenhouses Error")
        frappe.throw(_("Error fetching farms and greenhouses: {0}").format(str(e)))


@frappe.whitelist()
def getAllScoutedGreenhouses(date):
    """Greenhouses that have scouting data for a given date."""
    try:
        scouted = frappe.db.sql(
            """
            SELECT DISTINCT greenhouse
            FROM `tabScouting Entry`
            WHERE date_of_capture = %s
            ORDER BY greenhouse
            """,
            (date,),
            as_dict=True,
        )
        return {"greenhouses": [row.greenhouse for row in scouted]}
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Get All Scouted Greenhouses Error")
        frappe.throw(_("Error fetching scouted greenhouses: {0}").format(str(e)))


@frappe.whitelist()
def getRecentScoutingDates(date, limit=3):
    """Most recent distinct dates with any scouting activity on or before `date`.

    Drives the heatmap's "3-day comparison" so the columns line up with days
    that actually had scouting — calendar gaps (weekends, downtime) collapse
    instead of showing as empty cards.
    """
    try:
        rows = frappe.db.sql(
            """
            SELECT DISTINCT date_of_capture
            FROM `tabScouting Entry`
            WHERE date_of_capture <= %s
            ORDER BY date_of_capture DESC
            LIMIT %s
            """,
            (date, int(limit)),
            as_dict=True,
        )
        return {"dates": [str(r["date_of_capture"]) for r in rows]}
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Get Recent Scouting Dates Error")
        frappe.throw(_("Error fetching recent scouting dates: {0}").format(str(e)))


@frappe.whitelist()
def getRecentScoutingDatesPerGreenhouse(date, limit=3):
    """For each recently-active greenhouse, its own last `limit` scouting dates.

    "Recently active" = scouted on one of the last `limit` global scouting
    dates ≤ `date`. Per-greenhouse dates may extend further back: a house last
    scouted Mon, Wed, and last Fri shows those three — not the global Wed/Tue/Mon.
    """
    try:
        global_dates = frappe.db.sql(
            """
            SELECT DISTINCT date_of_capture
            FROM `tabScouting Entry`
            WHERE date_of_capture <= %s
            ORDER BY date_of_capture DESC
            LIMIT %s
            """,
            (date, int(limit)),
            as_dict=True,
        )
        if not global_dates:
            return {"greenhouses": {}}

        date_list = [r["date_of_capture"] for r in global_dates]

        gh_rows = frappe.db.sql(
            """
            SELECT DISTINCT greenhouse
            FROM `tabScouting Entry`
            WHERE date_of_capture IN %(dates)s
              AND greenhouse IS NOT NULL AND greenhouse != ''
            """,
            {"dates": tuple(date_list)},
            as_dict=True,
        )
        greenhouses = [r["greenhouse"] for r in gh_rows]
        if not greenhouses:
            return {"greenhouses": {}}

        rows = frappe.db.sql(
            """
            SELECT DISTINCT greenhouse, date_of_capture
            FROM `tabScouting Entry`
            WHERE date_of_capture <= %(date)s
              AND greenhouse IN %(ghs)s
            ORDER BY greenhouse ASC, date_of_capture DESC
            """,
            {"date": date, "ghs": tuple(greenhouses)},
            as_dict=True,
        )

        per_gh = {}
        cap = int(limit)
        for r in rows:
            gh = r["greenhouse"]
            bucket = per_gh.setdefault(gh, [])
            if len(bucket) < cap:
                bucket.append(str(r["date_of_capture"]))
        return {"greenhouses": per_gh}
    except Exception as e:
        frappe.log_error(
            frappe.get_traceback(),
            "Get Recent Scouting Dates Per Greenhouse Error",
        )
        frappe.throw(
            _("Error fetching per-greenhouse scouting dates: {0}").format(str(e))
        )
