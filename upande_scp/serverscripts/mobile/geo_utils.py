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
from shapely.geometry import Point, LineString, shape
from shapely.strtree import STRtree
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

# Per-block tree index used only by nearest_unit_in_block:
# { (utm_epsg, block): { "built_at": float, "used_at": float, "trees": [ {name,row,point_utm} ] } }
# Built on demand with one query for ONE block (not the farm-wide tree cache),
# kept while in use (TTL counted from last use) but rebuilt at least every
# BLOCK_TREE_MAX_AGE_SECONDS so edited trees are picked up.
_block_tree_cache: dict = {}
BLOCK_TREE_TTL_SECONDS = 300
BLOCK_TREE_MAX_AGE_SECONDS = 3600

# Per-block Triad index (UTM polygons in an STRtree), same TTLs as the tree index:
# { (utm_epsg, block): { "built_at", "used_at", "triads": [ {name,hexa,poly_utm,centroid} ], "tree" } }
_block_triad_cache: dict = {}


def clear_zone_cache():
    """Call this from a Zone doctype hook to invalidate immediately on save."""
    _zone_cache.clear()


def clear_tree_cache():
    """Call this from a Tree doctype hook to invalidate immediately on save."""
    _tree_cache.clear()
    _block_tree_cache.clear()
    _block_triad_cache.clear()


def get_dynamic_utm_epsg(latitude, longitude):
    """Calculates the correct UTM EPSG code based on a point's coordinates."""
    zone_number = int((longitude + 180) / 6) + 1
    epsg_prefix = 326 if latitude >= 0 else 327  # N / S hemisphere
    return f"EPSG:{epsg_prefix}{zone_number:02d}"


def feature_geometry(geojson_data):
    """The geometry and properties out of whichever GeoJSON shape a record has.

    Three shapes reach this app, and which one a record carries is an accident of
    how it was loaded rather than anything meaningful:

        {"type": "FeatureCollection", "features": [{"geometry": {...}}]}
        {"type": "Feature", "geometry": {...}}
        {"type": "LineString" | "Point", "coordinates": [...]}    bare geometry

    The tree cache has always understood all three. The zone cache understood only
    the first and dropped the rest **silently** — no log, no exception; the zone
    simply never entered the cache, so a scouted point matched the nearest
    *parseable* zone however far away it was.

    On staging that was 148,189 of 154,437 zones (96%). A point aimed at Simotwo
    GH 19 Bed 219 resolved to GH 17 Bed 84, 104 m away in a different greenhouse,
    and the entry was written with a bed and a zone that disagreed. Nothing about
    it looked like a failure.

    Returns ``(geometry, properties)``; geometry is None when there is nothing
    usable, and properties is always a dict so callers need not guard it.
    """
    if not isinstance(geojson_data, dict):
        return None, {}

    kind = geojson_data.get("type")

    if kind == "FeatureCollection":
        features = geojson_data.get("features") or []
        if not features:
            return None, {}
        feature = features[0] or {}
        return feature.get("geometry"), (feature.get("properties") or {})

    if kind == "Feature":
        return geojson_data.get("geometry"), (geojson_data.get("properties") or {})

    # A bare geometry object is its own geometry, and carries no properties.
    if geojson_data.get("coordinates") is not None:
        return geojson_data, {}

    return None, {}


def _build_zone_cache(utm_epsg: str, project_to_utm):
    """
    Load all zones from the database, parse their GeoJSON, transform them to
    UTM, and store the result in _zone_cache[utm_epsg].

    This runs once per UTM zone per CACHE_TTL_SECONDS window.
    """
    raw_zones = frappe.get_all("Zone", fields=["name", "bed", "geojson as raw_geojson"])

    built = []
    skipped = 0
    for zone in raw_zones:
        try:
            if not zone.raw_geojson:
                skipped += 1
                continue

            geometry, _props = feature_geometry(json.loads(zone.raw_geojson))
            if not geometry or geometry.get("type") != "LineString":
                skipped += 1
                continue

            coords = geometry.get("coordinates") or []
            if len(coords) < 2:
                skipped += 1
                continue

            line_utm = transform(project_to_utm, LineString(coords))
            built.append({
                "name": zone.name,
                "bed": zone.bed or "",
                "line_utm": line_utm,
            })
        except Exception as e:
            skipped += 1
            frappe.log_error(f"geo_utils: skipping zone {zone.name} during cache build", str(e))

    if skipped:
        # ONE line for the whole build, not one per zone: on a site where most
        # zones are unusable, per-zone logging is its own outage. A zone missing
        # from this cache cannot be matched, so the count is worth seeing.
        frappe.logger("upande_scp.geo").warning(
            "zone cache: %d of %d zones had no usable LineString geometry",
            skipped, len(raw_zones),
        )

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
            geometry, props = feature_geometry(json.loads(tree.raw_geojson))

            radius = DEFAULT_TREE_RADIUS_M
            if props.get("radius") is not None:
                try:
                    radius = float(props["radius"])
                except (TypeError, ValueError):
                    pass

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


def _project_point(latitude, longitude, accuracy):
    """(utm_epsg, project_to_utm, point_utm, buffer_m) for a scouted point."""
    lat = float(latitude)
    lon = float(longitude)
    accuracy_m = float(accuracy)
    utm_epsg = get_dynamic_utm_epsg(lat, lon)
    project_to_utm = Transformer.from_crs("EPSG:4326", utm_epsg, always_xy=True).transform
    point_utm = transform(project_to_utm, Point(lon, lat))
    return utm_epsg, project_to_utm, point_utm, max(3.0, min(accuracy_m, 50.0))


def _get_block_trees(utm_epsg, project_to_utm, block):
    """Trees of one block as UTM points; one filtered query per (re)build."""
    key = (utm_epsg, block)
    now = time.monotonic()
    entry = _block_tree_cache.get(key)
    if (
        entry
        and now - entry["used_at"] < BLOCK_TREE_TTL_SECONDS
        and now - entry["built_at"] < BLOCK_TREE_MAX_AGE_SECONDS
    ):
        entry["used_at"] = now
        return entry["trees"]

    built = []
    for tree in frappe.get_all(
        "Orchard Tree",
        filters={"block": block, "geojson": ["is", "set"]},
        fields=["name", "row", "geojson as raw_geojson"],
    ):
        try:
            geometry, _props = feature_geometry(json.loads(tree.raw_geojson))
            if not geometry or geometry.get("type") != "Point":
                continue
            coords = geometry.get("coordinates") or []
            if len(coords) < 2:
                continue
            built.append({
                "name": tree.name,
                "row": tree.row or "",
                "point_utm": transform(project_to_utm, Point(coords[0], coords[1])),
            })
        except Exception as e:
            frappe.log_error(f"geo_utils: skipping tree {tree.name} in block index", str(e))
    _block_tree_cache[key] = {"built_at": now, "used_at": now, "trees": built}
    return built


def block_has_triads(block):
    """True when the block holds at least one Triad (Triad doctype present on the site)."""
    try:
        if not block or not frappe.db.exists("DocType", "Triad"):
            return False
        return bool(frappe.db.exists("Triad", {"block": block}))
    except Exception:
        return False


def _get_block_triads(utm_epsg, project_to_utm, block):
    """Triads of one block as UTM polygons plus an STRtree; one query per (re)build."""
    key = (utm_epsg, block)
    now = time.monotonic()
    entry = _block_triad_cache.get(key)
    if (
        entry
        and now - entry["used_at"] < BLOCK_TREE_TTL_SECONDS
        and now - entry["built_at"] < BLOCK_TREE_MAX_AGE_SECONDS
    ):
        entry["used_at"] = now
        return entry

    triads = []
    for t in frappe.get_all(
        "Triad",
        filters={"block": block, "geojson": ["is", "set"]},
        fields=["name", "row", "geojson as raw_geojson"],
        order_by="name asc",
    ):
        try:
            geometry, _props = feature_geometry(json.loads(t.raw_geojson))
            if not geometry or geometry.get("type") != "Polygon":
                continue
            poly = transform(project_to_utm, shape(geometry))
            if poly.is_empty:
                continue
            if not poly.is_valid:
                poly = poly.buffer(0)
            triads.append({
                "name": t.name,
                "hexa": t.row or "",
                "poly_utm": poly,
                "centroid": poly.centroid,
            })
        except Exception as e:
            frappe.log_error(f"geo_utils: skipping triad {t.name} in block index", str(e))
    tree = STRtree([t["poly_utm"] for t in triads]) if triads else None
    entry = {"built_at": now, "used_at": now, "triads": triads, "tree": tree}
    _block_triad_cache[key] = entry
    return entry


def triad_in_block(latitude, longitude, accuracy, block):
    """Map a GPS point inside a block to ``(triad, hexa)``.

    The containing Triad polygon wins (a point on a shared edge goes to the lowest
    name); otherwise the nearest Triad centroid within max(3, min(accuracy, 50)) m;
    otherwise ``(None, None)``. Never searches outside the block.
    """
    try:
        if not block:
            return None, None
        utm_epsg, project_to_utm, point_utm, buffer_m = _project_point(latitude, longitude, accuracy)
        entry = _get_block_triads(utm_epsg, project_to_utm, block)
        triads = entry["triads"]
        if not triads:
            return None, None

        hits = [triads[i] for i in entry["tree"].query(point_utm, predicate="intersects")]
        if hits:
            best = min(hits, key=lambda t: t["name"])
            return best["name"], best["hexa"] or None

        best, best_d = None, float("inf")
        for t in triads:
            d = point_utm.distance(t["centroid"])
            if d < best_d or (d == best_d and best is not None and t["name"] < best["name"]):
                best, best_d = t, d
        if best is not None and best_d <= buffer_m:
            return best["name"], best["hexa"] or None
        return None, None
    except Exception as e:
        frappe.log_error("Error", f"Error in triad_in_block: {e}")
        return None, None


def _nearest_zone_among(zones, point_utm, buffer_m):
    best, best_d = None, float("inf")
    for zone in zones:
        d = point_utm.distance(zone["line_utm"])
        if d <= buffer_m and d < best_d:
            best, best_d = zone, d
    return best


def nearest_unit_in_block(latitude, longitude, accuracy, block):
    """Map a GPS point inside a block to ``(tree, row)`` without the scout picking a row.

    Nearest Orchard Tree of the block, from a per-block index (see _get_block_trees; its row is the tree's row). A block with
    no mapped trees falls back to the nearest Zone line whose bed is one of the
    block's rows (Beds with ``greenhouse`` = block). Only candidates within the
    same buffer ``get_zone_from_coordinates`` uses, max(3, min(accuracy, 50)) m,
    count; otherwise ``(None, None)``. Never searches outside the block.
    """
    try:
        if not block:
            return None, None
        utm_epsg, project_to_utm, point_utm, buffer_m = _project_point(latitude, longitude, accuracy)

        trees = _get_block_trees(utm_epsg, project_to_utm, block)
        if trees:
            best, best_d = None, float("inf")
            for t in trees:
                d = point_utm.distance(t["point_utm"])
                if d < best_d:
                    best, best_d = t, d
            if best is not None and best_d <= buffer_m:
                return best["name"], best["row"] or None
            return None, None

        rows = set(frappe.get_all("Bed", filters={"greenhouse": block}, pluck="name"))
        if not rows:
            return None, None
        zones = [z for z in _get_cached_zones(utm_epsg, project_to_utm) if z["bed"] in rows]
        zone = _nearest_zone_among(zones, point_utm, buffer_m)
        return (None, zone["bed"]) if zone else (None, None)
    except Exception as e:
        frappe.log_error("Error", f"Error in nearest_unit_in_block: {e}")
        return None, None


def nearest_zone_in_greenhouse(latitude, longitude, accuracy, greenhouse):
    """Nearest Zone (a bed's line) of a greenhouse within the GPS buffer, else None.

    The zone's ``bed`` is the bed to record. Candidates are restricted to beds
    whose ``greenhouse`` is this one.
    """
    try:
        if not greenhouse:
            return None
        utm_epsg, project_to_utm, point_utm, buffer_m = _project_point(latitude, longitude, accuracy)
        beds = set(frappe.get_all("Bed", filters={"greenhouse": greenhouse}, pluck="name"))
        if not beds:
            return None
        zones = [z for z in _get_cached_zones(utm_epsg, project_to_utm) if z["bed"] in beds]
        zone = _nearest_zone_among(zones, point_utm, buffer_m)
        return zone["name"] if zone else None
    except Exception as e:
        frappe.log_error("Error", f"Error in nearest_zone_in_greenhouse: {e}")
        return None


#: Kept as the old private name: this helper is shared with the web endpoint now
#: (`geo.get_beds_and_zones`), so it is public, but existing callers and tests
#: still reach for the underscore.
_feature_geometry = feature_geometry
