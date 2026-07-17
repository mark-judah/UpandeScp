"""3D rose map — one rose-shaped object per Zone, grouped by Greenhouse.

Mirrors the avocado_scouts_map structure but for greenhouses + zones. Each
zone's centroid is precomputed server-side so the client only has to place
InstancedMesh instances at fixed lng/lat anchors.
"""

import json

import frappe

from upande_scp.serverscripts.cache_utils import (
    K_FARM_HIERARCHY,
    K_GREENHOUSES_GEOJSON,
    K_ZONE_CENTROIDS,
    TTL_LONG,
    get_or_set,
)
from upande_scp.www.rose_scouting.index import (
    _build_farm_coordinates,
    _build_farm_hierarchy,
    _build_greenhouses_geojson,
)


def _coord_centroid(coords):
    """Average all numeric [lng, lat] pairs in a (possibly nested) coords array."""
    sx, sy, n = 0.0, 0.0, 0
    stack = [coords]
    while stack:
        item = stack.pop()
        if not item:
            continue
        if (
            isinstance(item, (list, tuple))
            and len(item) >= 2
            and isinstance(item[0], (int, float))
            and isinstance(item[1], (int, float))
        ):
            sx += item[0]
            sy += item[1]
            n += 1
        elif isinstance(item, (list, tuple)):
            for sub in item:
                stack.append(sub)
    if not n:
        return None
    return [sx / n, sy / n]


def _build_zone_centroids():
    """Return [{name, greenhouse, bed, lng, lat}] for every zone with geojson.

    Centroid = mean of all coordinates across all features in the zone's
    raw_geojson. That's a coarse approximation but it is consistent and
    cheap — exact enough to anchor a single rose object inside the zone.
    """
    rows = frappe.get_all(
        "Zone",
        filters={"geojson": ["is", "set"]},
        fields=["name", "greenhouse", "bed", "geojson as raw_geojson"],
        limit_page_length=0,
    )
    out = []
    for r in rows:
        raw = r.get("raw_geojson") or ""
        if not raw:
            continue
        try:
            geo = json.loads(raw)
        except (TypeError, ValueError):
            continue
        feats = geo.get("features") if isinstance(geo, dict) else None
        if not feats:
            continue
        all_coords = []
        for f in feats:
            if not isinstance(f, dict):
                continue
            geom = f.get("geometry") or {}
            c = geom.get("coordinates")
            if c:
                all_coords.append(c)
        centroid = _coord_centroid(all_coords)
        if not centroid:
            continue
        out.append({
            "name": r["name"],
            "greenhouse": r.get("greenhouse") or "",
            "bed": r.get("bed") or "",
            "lng": centroid[0],
            "lat": centroid[1],
        })
    return out


def get_context(context):
    context.no_cache = 1
    map_settings = frappe.get_doc("Map Settings", "Map Settings")

    context.lat = map_settings.lat
    context.lon = map_settings.lon
    context.default_zoom = map_settings.default_zoom
    context.farm_coordinates = _build_farm_coordinates(map_settings)
    context.csrf_token = frappe.sessions.get_csrf_token()

    context.greenhouses_geojson = get_or_set(
        K_GREENHOUSES_GEOJSON, _build_greenhouses_geojson, ttl=TTL_LONG
    )
    context.farm_hierarchy = get_or_set(
        K_FARM_HIERARCHY, _build_farm_hierarchy, ttl=TTL_LONG
    )
    context.zone_centroids = get_or_set(
        K_ZONE_CENTROIDS, _build_zone_centroids, ttl=TTL_LONG
    )
    return context
