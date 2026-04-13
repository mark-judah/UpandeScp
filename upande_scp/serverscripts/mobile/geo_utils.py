"""
Shared GPS / zone-detection utilities used by scouting and sprayer entry scripts.

Zone geometries are cached in memory for CACHE_TTL_SECONDS so that batch GPS
uploads (20+ points per request) don't hit the database and re-parse GeoJSON
on every single point.  The cache is keyed by UTM EPSG code so it handles
multi-farm setups correctly.  It is invalidated automatically when it expires
or when explicitly cleared via clear_zone_cache().
"""
import json
import time
import frappe
from shapely.geometry import Point, LineString
from shapely.ops import transform
from pyproj import Transformer

# ---------------------------------------------------------------------------
# In-process geometry cache
# ---------------------------------------------------------------------------

CACHE_TTL_SECONDS = 300  # 5 minutes — refresh if zones are edited

# { utm_epsg: { "built_at": float, "zones": [ { "name", "bed", "line_utm" } ] } }
_zone_cache: dict = {}


def clear_zone_cache():
    """Call this from a Zone doctype hook to invalidate immediately on save."""
    _zone_cache.clear()


def get_dynamic_utm_epsg(latitude, longitude):
    """Calculates the correct UTM EPSG code based on a point's coordinates."""
    zone_number = int((longitude + 180) / 6) + 1
    epsg_prefix = 326 if latitude >= 0 else 327  # N / S hemisphere
    return f"EPSG:{epsg_prefix}{zone_number:02d}"


def _build_zone_cache(utm_epsg: str, project_to_utm):
    """
    Load all zones from the database, parse their GeoJSON, transform them to
    UTM, and store the result in _zone_cache[utm_epsg].

    This runs once per UTM zone per CACHE_TTL_SECONDS window.
    """
    raw_zones = frappe.get_all("Zone", fields=["name", "bed", "greenhouse", "raw_geojson"])

    built = []
    for zone in raw_zones:
        try:
            if not zone.raw_geojson:
                continue
            geojson_data = json.loads(zone.raw_geojson)
            if (
                geojson_data.get("type") == "FeatureCollection"
                and geojson_data.get("features")
            ):
                feature = geojson_data["features"][0]
                geometry = feature.get("geometry", {})
                if geometry.get("type") == "LineString":
                    coords = geometry.get("coordinates", [])
                    if len(coords) >= 2:
                        line_wgs84 = LineString(coords)
                        line_utm = transform(project_to_utm, line_wgs84)
                        built.append({
                            "name": zone.name,
                            "bed": zone.bed or "",
                            "greenhouse": zone.greenhouse or "",
                            "line_utm": line_utm,
                        })
        except Exception as e:
            frappe.log_error(f"geo_utils: skipping zone {zone.name} during cache build", str(e))

    _zone_cache[utm_epsg] = {"built_at": time.monotonic(), "zones": built}
    return built


def _get_cached_zones(utm_epsg: str, project_to_utm):
    """Return cached zone list, rebuilding if stale or missing."""
    entry = _zone_cache.get(utm_epsg)
    if entry and (time.monotonic() - entry["built_at"]) < CACHE_TTL_SECONDS:
        return entry["zones"]
    return _build_zone_cache(utm_epsg, project_to_utm)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_zone_from_coordinates(latitude, longitude, bed, accuracy, greenhouse=None):
    try:
        lat = float(latitude)
        lon = float(longitude)
        accuracy_m = float(accuracy)

        utm_epsg = get_dynamic_utm_epsg(lat, lon)

        project_to_utm = Transformer.from_crs(
            "EPSG:4326", utm_epsg, always_xy=True
        ).transform

        scout_point_utm = transform(project_to_utm, Point(lon, lat))

        buffer_m = max(3.0, min(accuracy_m, 50.0))

        # Use pre-built cached geometries — no DB hit, no JSON parse, no
        # per-point LineString construction.
        all_zones = _get_cached_zones(utm_epsg, project_to_utm)

        zones = all_zones
        used_fallback = False

        if greenhouse and greenhouse != "":
            gh_zones = [z for z in zones if z.get("greenhouse") == greenhouse]
            if not gh_zones:
                return None, 0.0, f"No zones configured for greenhouse: {greenhouse}"
            zones = gh_zones

        if bed and bed != "":
            bed_zones = [z for z in zones if z.get("bed") == bed]
            used_fallback = used_fallback or not bool(bed_zones)
            zones = bed_zones if bed_zones else zones

        if not zones:
            return None, 0.0, "No zones configured in the system"

        closest_zone = None
        min_distance = float("inf")
        confidence = 0.0

        for zone in zones:
            try:
                line_utm = zone["line_utm"]
                distance_m = scout_point_utm.distance(line_utm)
                zone_polygon_utm = line_utm.buffer(buffer_m)

                if zone_polygon_utm.contains(scout_point_utm):
                    if distance_m < min_distance:
                        min_distance = distance_m
                        closest_zone = zone["name"]

                        if distance_m <= accuracy_m * 0.3:
                            confidence = 1.0
                        elif distance_m <= accuracy_m * 0.6:
                            confidence = 0.9
                        elif distance_m <= accuracy_m:
                            confidence = 0.8
                        else:
                            confidence = 0.7

                elif distance_m < min_distance:
                    min_distance = distance_m
                    closest_zone = zone["name"]

                    if distance_m <= accuracy_m * 1.5:
                        confidence = 0.5
                    elif distance_m <= accuracy_m * 2.0:
                        confidence = 0.3
                    else:
                        confidence = 0.1

            except Exception as e:
                frappe.log_error(f"geo_utils: error processing zone {zone['name']}", str(e))
                continue

        if closest_zone:
            return closest_zone, confidence, {
                "distance": f"{min_distance:.1f}",
                "buffer": f"{buffer_m:.1f}",
                "fallback": used_fallback,
            }

        return None, 0.0, f"No zone geometry found within range (accuracy: {accuracy_m}m)"

    except Exception as e:
        error_msg = f"Error in get_zone_from_coordinates: {str(e)}"
        frappe.log_error("Error", error_msg)
        return None, 0.0, error_msg
