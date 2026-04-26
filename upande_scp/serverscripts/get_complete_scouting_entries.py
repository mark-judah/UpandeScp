import frappe

from upande_scp.serverscripts import scouting_metrics
from upande_scp.serverscripts.cache_utils import (
    K_CROPS_SCOUTED,
    K_SM_UNITS_BY_WH,
    K_SM_ZONE_COUNTS_BY_GH,
    TTL_LONG,
    TTL_MEDIUM,
    get_or_set,
)


CACHE_TTL = 300  # seconds; legend colors + zone counts rarely change


def _cached_pest_colors():
    cache = frappe.cache()
    key = "scouting_dashboard:pest_colors"
    value = cache.get_value(key)
    if value is None:
        value = frappe.get_all(
            "Pest",
            fields=["name", "pests_legend_color"],
            limit_page_length=0,
        )
        cache.set_value(key, value, expires_in_sec=CACHE_TTL)
    return value


def _cached_disease_colors():
    cache = frappe.cache()
    key = "scouting_dashboard:disease_colors"
    value = cache.get_value(key)
    if value is None:
        value = frappe.get_all(
            "Plant Disease",
            fields=["name", "disease_legend_color"],
            limit_page_length=0,
        )
        cache.set_value(key, value, expires_in_sec=CACHE_TTL)
    return value


def _cached_zones_by_greenhouse():
    """{greenhouse: zone_count} — shares the Zone-invalidated cache with
    scouting_metrics_api so an edit flushes both this meta payload and any
    other consumer in a single hook."""
    return get_or_set(
        K_SM_ZONE_COUNTS_BY_GH,
        scouting_metrics.get_zone_counts_by_greenhouse,
        ttl=TTL_LONG,
    )


def _cached_units_by_warehouse():
    """{warehouse: {type, count, farm}} — zones for greenhouses, trees for blocks."""
    return get_or_set(
        K_SM_UNITS_BY_WH,
        scouting_metrics.get_units_by_warehouse,
        ttl=TTL_LONG,
    )


def _cached_crops_with_farms():
    return get_or_set(
        K_CROPS_SCOUTED,
        scouting_metrics.get_crops_with_farms,
        ttl=TTL_MEDIUM,
    )


def _fetch_scouting_payload(from_date, to_date, greenhouse_filter, include_meta=True):
    # Date filter is always applied. The dashboard sends a single "greenhouse"
    # parameter for either warehouse type; match against `greenhouse` OR
    # `block` so block-based scouting (avocado orchards) scopes correctly.
    entry_filters = [["date_of_capture", "between", [from_date, to_date]]]
    or_filters = None
    if greenhouse_filter:
        or_filters = [
            ["greenhouse", "=", greenhouse_filter],
            ["block", "=", greenhouse_filter],
        ]

    scouting_entries = frappe.get_all(
        "Scouting Entry",
        filters=entry_filters,
        or_filters=or_filters,
        fields=[
            "name",
            "scouts_name",
            "greenhouse",
            "bed",
            "zone",
            "block",
            "`row`",
            "tree",
            "crop_scouted",
            "time_of_capture",
            "date_of_capture",
            "owner",
            "modified_by",
        ],
        order_by="date_of_capture desc, time_of_capture desc",
        limit_page_length=0,
    )

    payload = {
        "entries": [],
        "total_entries": len(scouting_entries),
        "filters_applied": {
            "from_date": from_date,
            "to_date": to_date,
            "greenhouse": greenhouse_filter,
        },
    }

    if include_meta:
        payload["pest_colors"] = _cached_pest_colors()
        payload["disease_colors"] = _cached_disease_colors()
        # Legacy field — kept so older clients still render.
        payload["zones_by_greenhouse"] = _cached_zones_by_greenhouse()
        # New: warehouse-type-aware unit map (zones for greenhouses, trees for
        # blocks) plus the crop allow-list.
        payload["units_by_greenhouse"] = _cached_units_by_warehouse()
        payload["crops_scouted"] = _cached_crops_with_farms()

    entry_names = [e.name for e in scouting_entries]
    if not entry_names:
        return payload

    pests = frappe.get_all(
        "Pests Scouting Entry",
        filters=[["parent", "in", entry_names]],
        fields=["parent", "plant_section", "pest", "stage", "count"],
        limit_page_length=0,
    )

    diseases = frappe.get_all(
        "Diseases Scouting Entry",
        filters=[["parent", "in", entry_names]],
        fields=["parent", "disease", "plant_section", "stage"],
        limit_page_length=0,
    )

    traps = frappe.get_all(
        "Trap Scouting Entry",
        filters=[["parent", "in", entry_names]],
        fields=["parent", "trap", "pest", "location", "count"],
        limit_page_length=0,
    )

    entries_dict = {entry.name: entry for entry in scouting_entries}

    for pest in pests:
        parent = pest.pop("parent", None)
        if parent in entries_dict:
            entries_dict[parent].setdefault("pests", []).append(pest)

    for disease in diseases:
        parent = disease.pop("parent", None)
        if parent in entries_dict:
            entries_dict[parent].setdefault("diseases", []).append(disease)

    for trap in traps:
        parent = trap.pop("parent", None)
        if parent in entries_dict:
            entries_dict[parent].setdefault("traps", []).append(trap)

    payload["entries"] = list(entries_dict.values())
    return payload


@frappe.whitelist()
def getCompleteScoutingEntries(from_date=None, to_date=None, greenhouse=None):
    try:
        from_date = from_date or frappe.form_dict.get("from_date")
        to_date = to_date or frappe.form_dict.get("to_date")
        greenhouse_filter = greenhouse or frappe.form_dict.get("greenhouse")

        if not from_date or not to_date:
            frappe.throw("from_date and to_date are required")

        return _fetch_scouting_payload(from_date, to_date, greenhouse_filter, include_meta=True)
    except Exception as e:
        frappe.log_error(f"Error in scouting data extraction: {str(e)}", "Scouting Entry API")
        frappe.throw(str(e))


@frappe.whitelist()
def getScoutingEntriesChunk(from_date=None, to_date=None, greenhouse=None, include_meta=0):
    """Lean monthly-chunk endpoint for the scouting dashboard.

    When include_meta is falsy, skips pest_colors/disease_colors/zones_by_greenhouse
    so background chunks don't re-ship shared metadata that the client fetched once.
    """
    try:
        from_date = from_date or frappe.form_dict.get("from_date")
        to_date = to_date or frappe.form_dict.get("to_date")
        greenhouse_filter = greenhouse or frappe.form_dict.get("greenhouse")
        include_meta_flag = str(include_meta).lower() in ("1", "true", "yes")

        if not from_date or not to_date:
            frappe.throw("from_date and to_date are required")

        return _fetch_scouting_payload(
            from_date,
            to_date,
            greenhouse_filter,
            include_meta=include_meta_flag,
        )
    except Exception as e:
        frappe.log_error(f"Error in scouting chunk extraction: {str(e)}", "Scouting Entry API")
        frappe.throw(str(e))
