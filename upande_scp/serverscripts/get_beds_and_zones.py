import frappe

from upande_scp.serverscripts.cache_utils import (
    K_BEDS_AND_ZONES,
    TTL_LONG,
    get_or_set,
)


def _build_beds_and_zones():
    beds = frappe.get_all("Bed", fields=["name", "variety"], limit_page_length=0)
    zones = frappe.get_all(
        "Zone",
        filters={"raw_geojson": ["is", "set"]},
        fields=["name", "raw_geojson", "bed"],
        limit_page_length=0,
    )

    bed_map = {b["name"]: {**b, "zones": []} for b in beds}
    for z in zones:
        bed = bed_map.get(z["bed"])
        if bed is not None:
            # Some sites (mona) imported zone names wrapped in literal
            # double-quotes (e.g. '"Main GH 01 - MFK - Bed 1 - Zone 1"'). Strip
            # them so the client's greenhouse parse (slice before " - Bed ")
            # matches the clean greenhouse/warehouse name, and so the zone names
            # line up with the (also-normalised) heatmap marker keys.
            bed["zones"].append(
                {"name": (z["name"] or "").strip('"'), "raw_geojson": z["raw_geojson"]}
            )

    variety_map = {}
    for bed in bed_map.values():
        variety = bed["variety"]
        bucket = variety_map.setdefault(variety, {"variety": variety, "beds": []})
        if bed["zones"]:
            bucket["beds"].append({"name": bed["name"], "zones": bed["zones"]})

    return list(variety_map.values())


@frappe.whitelist()
def getBedsAndZones():
    try:
        frappe.response["data"] = get_or_set(
            K_BEDS_AND_ZONES, _build_beds_and_zones, ttl=TTL_LONG
        )
    except Exception as e:
        frappe.log_error(title="getBedsAndZones Error", message=str(e))
        frappe.throw("Error fetching map data. Please check server logs for details.")
