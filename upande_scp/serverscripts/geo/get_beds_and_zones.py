import json

import frappe

from upande_scp.serverscripts.common.cache_utils import (
    K_BEDS_AND_ZONES_V2,
    TTL_LONG,
    get_or_set,
)
from upande_scp.serverscripts.geo.zone_encoding import encode_beds


def _build_beds_and_zones():
    beds = frappe.get_all("Bed", fields=["name", "variety"], limit_page_length=0)
    zone_rows = frappe.get_all(
        "Zone",
        filters={"geojson": ["is", "set"]},
        fields=["name", "geojson", "bed"],
        limit_page_length=0,
    )

    bed_names = {b["name"] for b in beds}

    zones = []
    for z in zone_rows:
        bed_name = z["bed"]
        if bed_name not in bed_names:
            continue

        prefix = f"{bed_name} - Zone "
        name = z["name"]
        if not name.startswith(prefix) or not name[len(prefix):].isdigit():
            continue
        order = int(name[len(prefix):])

        try:
            gj = json.loads(z["geojson"])
            feature = gj["features"][0]
            coords = feature["geometry"]["coordinates"]
            line_id = feature["properties"]["line_id"]
            if len(coords) != 2:
                continue
        except Exception:
            continue

        zones.append({
            "bed": bed_name,
            "name": name,
            "line_id": line_id,
            "order": order,
            "coords": coords,
        })

    encoded_beds = encode_beds(zones)

    bed_variety = {b["name"]: b["variety"] for b in beds}
    encoded_by_bed_name = {entry[0]: entry for entry in encoded_beds}

    variety_map = {}
    for bed_name, variety in bed_variety.items():
        entry = encoded_by_bed_name.get(bed_name)
        if entry is None:
            continue
        bucket = variety_map.setdefault(variety, {"variety": variety, "beds": []})
        bucket["beds"].append(entry)

    return {"v": 2, "varieties": list(variety_map.values())}


@frappe.whitelist()
def getBedsAndZones():
    try:
        frappe.response["data"] = get_or_set(
            K_BEDS_AND_ZONES_V2, _build_beds_and_zones, ttl=TTL_LONG
        )
    except Exception as e:
        frappe.log_error(title="getBedsAndZones Error", message=str(e))
        frappe.throw("Error fetching map data. Please check server logs for details.")
