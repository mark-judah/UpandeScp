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

# { utm_epsg: { "built_at": float, "trees": [ { "name", "row", "block", "radius_m", "point_utm" } ] } }
_tree_cache: dict = {}

DEFAULT_TREE_RADIUS_M = 0.5


def clear_zone_cache():
    """Call this from a Zone doctype hook to invalidate immediately on save."""
    _zone_cache.clear()


def clear_tree_cache():
    """Call this from a Tree doctype hook to invalidate immediately on save."""
    _tree_cache.clear()


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
    raw_zones = frappe.get_all("Zone", fields=["name", "bed", "geojson as raw_geojson"])

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


def _build_tree_cache(utm_epsg: str, project_to_utm):
    """
    Load all trees from the database, parse each Tree's Point GeoJSON, transform
    to UTM, and store in _tree_cache[utm_epsg]. Mirrors _build_zone_cache.
    """
    raw_trees = frappe.get_all(
        "Orchard Tree",
        fields=["name", "row", "block", "geojson as raw_geojson"],
    )

    built = []
    for tree in raw_trees:
        try:
            if not tree.raw_geojson:
                continue
            geojson_data = json.loads(tree.raw_geojson)
            geometry = None
            radius = DEFAULT_TREE_RADIUS_M
            
            # Handle FeatureCollection format
            if (
                geojson_data.get("type") == "FeatureCollection"
                and geojson_data.get("features")
            ):
                feature = geojson_data["features"][0]
                geometry = feature.get("geometry", {})
                props = feature.get("properties", {}) or {}
                if props.get("radius") is not None:
                    try:
                        radius = float(props["radius"])
                    except (TypeError, ValueError):
                        pass
            # Handle Feature format
            elif geojson_data.get("type") == "Feature":
                geometry = geojson_data.get("geometry", {})
                props = geojson_data.get("properties", {}) or {}
                if props.get("radius") is not None:
                    try:
                        radius = float(props["radius"])
                    except (TypeError, ValueError):
                        pass
            # Handle direct Point format
            elif geojson_data.get("type") == "Point":
                geometry = geojson_data

            if not geometry or geometry.get("type") != "Point":
                continue

            coords = geometry.get("coordinates") or []
            if len(coords) < 2:
                continue

            point_wgs84 = Point(coords[0], coords[1])
            point_utm = transform(project_to_utm, point_wgs84)
            built.append({
                "name": tree.name,
                "row": tree.row or "",
                "block": tree.block or "",
                "radius_m": radius,
                "point_utm": point_utm,
            })
        except Exception as e:
            frappe.log_error(
                f"geo_utils: skipping tree {tree.name} during cache build", str(e)
            )

    _tree_cache[utm_epsg] = {"built_at": time.monotonic(), "trees": built}
    return built


def _get_cached_trees(utm_epsg: str, project_to_utm):
    """Return cached tree list, rebuilding if stale or missing."""
    entry = _tree_cache.get(utm_epsg)
    if entry and (time.monotonic() - entry["built_at"]) < CACHE_TTL_SECONDS:
        return entry["trees"]
    return _build_tree_cache(utm_epsg, project_to_utm)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_zone_from_coordinates(latitude, longitude, bed, accuracy):
    """
    Find the nearest Zone for a given GPS point.
    
    Args:
        latitude: GPS latitude
        longitude: GPS longitude
        bed: Bed name to filter zones (optional, but recommended)
        accuracy: GPS accuracy in meters
        
    Returns:
        tuple: (zone_name, confidence, details_dict)
        - zone_name: Name of the closest zone or None
        - confidence: 0.0 to 1.0
        - details: dict with distance, buffer, fallback info
    """
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

        # If a bed filter is requested, match on the Zone's bed field exactly
        # (mirrors the original DB filter={"bed": bed}).  Fall back to all
        # zones only when no zones are configured for that bed.
        if bed and bed != "":
            bed_zones = [z for z in all_zones if z["bed"] == bed]
            zones = bed_zones if bed_zones else all_zones
            used_fallback = not bool(bed_zones)
        else:
            zones = all_zones
            used_fallback = False

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


def get_tree_from_coordinates(latitude, longitude, row, accuracy, block=None):
    """
    Find the nearest Orchard Tree for a given GPS point.
    
    Args:
        latitude: GPS latitude
        longitude: GPS longitude
        row: Row name to filter trees (primary filter)
        accuracy: GPS accuracy in meters
        block: Block name (secondary filter, used as fallback)
        
    Returns:
        tuple: (tree_name, confidence, details_dict)
        - tree_name: Name of the closest tree or None
        - confidence: 0.0 to 1.0
        - details: dict with distance, buffer, radius, fallback info
    """
    try:
        lat = float(latitude)
        lon = float(longitude)
        accuracy_m = float(accuracy)

        utm_epsg = get_dynamic_utm_epsg(lat, lon)
        project_to_utm = Transformer.from_crs(
            "EPSG:4326", utm_epsg, always_xy=True
        ).transform

        scout_point_utm = transform(project_to_utm, Point(lon, lat))

        # Get all cached trees
        all_trees = _get_cached_trees(utm_epsg, project_to_utm)

        if not all_trees:
            return None, 0.0, "No trees configured in the system"

        # --- Smart filtering with fallbacks ---
        # Priority 1: Match by exact row
        # Priority 2: If no row match, try block (if provided)
        # Priority 3: Fall back to all trees (last resort)
        
        used_fallback = False
        fallback_level = "none"
        
        if row:
            candidates = [t for t in all_trees if t["row"] == row]
            
            if not candidates and block:
                # Try block as secondary filter
                candidates = [t for t in all_trees if t["block"] == block]
                used_fallback = True
                fallback_level = "block"
                
            if not candidates:
                # Last resort: use all trees
                candidates = all_trees
                used_fallback = True
                fallback_level = "all_trees"
        elif block:
            # No row specified, but block is provided
            candidates = [t for t in all_trees if t["block"] == block]
            if not candidates:
                candidates = all_trees
                used_fallback = True
                fallback_level = "all_trees"
        else:
            # Neither row nor block specified
            candidates = all_trees
            used_fallback = True
            fallback_level = "all_trees"

        if not candidates:
            return None, 0.0, "No matching trees found"

        # Find the nearest tree by distance
        closest_tree = None
        min_distance = float("inf")
        closest_radius = DEFAULT_TREE_RADIUS_M

        for tree in candidates:
            try:
                distance_m = scout_point_utm.distance(tree["point_utm"])
                if distance_m < min_distance:
                    min_distance = distance_m
                    closest_tree = tree["name"]
                    closest_radius = tree["radius_m"]
            except Exception as e:
                frappe.log_error(
                    f"geo_utils: error processing tree {tree['name']}", str(e)
                )
                continue

        if closest_tree is None:
            return None, 0.0, f"No tree geometry found within range (accuracy: {accuracy_m}m)"

        # Calculate confidence based on distance vs tree radius and GPS accuracy
        tolerance = max(closest_radius, accuracy_m)
        
        if min_distance <= closest_radius:
            confidence = 1.0  # GPS point is within the tree's radius
        elif min_distance <= tolerance * 0.6:
            confidence = 0.9
        elif min_distance <= tolerance:
            confidence = 0.8
        elif min_distance <= tolerance * 1.5:
            confidence = 0.5
        elif min_distance <= tolerance * 2.0:
            confidence = 0.3
        else:
            confidence = 0.1

        # Build detailed response
        details = {
            "distance": f"{min_distance:.2f}",
            "buffer": f"{tolerance:.2f}",
            "radius": f"{closest_radius:.2f}",
            "fallback": used_fallback,
            "fallback_level": fallback_level,
            "candidates_count": len(candidates),
            "total_trees": len(all_trees)
        }

        # Log if fallback was used (this helps with debugging)
        if used_fallback and fallback_level != "none":
            frappe.log_error(
                f"Tree detection used fallback to {fallback_level}",
                f"Row='{row}' Block='{block}' -> found {closest_tree} at {min_distance:.2f}m"
            )

        return closest_tree, confidence, details

    except Exception as e:
        error_msg = f"Error in get_tree_from_coordinates: {str(e)}"
        frappe.log_error("Error", error_msg)
        return None, 0.0, error_msg