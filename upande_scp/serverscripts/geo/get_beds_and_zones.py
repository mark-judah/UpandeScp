import json

import frappe

from upande_scp.serverscripts.common.cache_utils import (
    K_BEDS_AND_ZONES_V2,
    TTL_LONG,
    get_or_set,
)
from upande_scp.serverscripts.geo.zone_encoding import encode_beds
from upande_scp.serverscripts.mobile.geo_utils import feature_geometry


def decode_zone(row, bed_names=None):
    """One Zone row as the encoder needs it, or ``None`` when it cannot be used.

    This used to read the GeoJSON as ``gj["features"][0]`` — one of the three
    shapes the data actually comes in — and swallow everything else in a bare
    ``except Exception: continue``. On the live site 148,186 of 154,434 zones
    (96%) are stored as a bare ``Feature``, so almost every zone was dropped
    without a log. The endpoint returned beds with no zones under them, and every
    map in the React app — scouting heatmap, observation map, the 3D view, the
    Application Plan's picker — showed "Zone geometry not available for this
    greenhouse" or sat for ever on "Zone polygons are being parsed in the
    background". It looked like missing data rather than a parse that had failed.

    `feature_geometry` already understood all three shapes; the mobile endpoints
    have used it for months. This one simply never did.

    Refusals that remain deliberate: a bed outside the list, a name that does not
    carry its order, a line that is not a two-point segment, and a feature with no
    ``line_id`` — the wire format is built around all four, and guessing at any of
    them would put a zone somewhere it is not.
    """
    if not row:
        return None

    bed_name = row.get("bed")
    if not bed_name:
        return None
    if bed_names is not None and bed_name not in bed_names:
        return None

    prefix = f"{bed_name} - Zone "
    name = row.get("name") or ""
    if not name.startswith(prefix) or not name[len(prefix):].isdigit():
        return None
    order = int(name[len(prefix):])

    raw = row.get("geojson")
    if not raw:
        return None
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return None

    geometry, properties = feature_geometry(raw)
    if not geometry:
        return None

    coords = geometry.get("coordinates")
    if not isinstance(coords, list) or len(coords) != 2:
        return None

    line_id = properties.get("line_id")
    if line_id is None:
        return None

    return {
        "bed": bed_name,
        "name": name,
        "line_id": line_id,
        "order": order,
        "coords": coords,
    }


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
    skipped = 0
    for z in zone_rows:
        decoded = decode_zone(z, bed_names)
        if decoded is None:
            skipped += 1
            continue
        zones.append(decoded)

    # Silence is what made this take months to find: 96% of zones were dropped
    # and nothing anywhere said so.
    if skipped:
        frappe.logger("scp_zones").info(
            f"beds_and_zones: {len(zones)} zones encoded, {skipped} skipped "
            f"of {len(zone_rows)} with geometry"
        )

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
