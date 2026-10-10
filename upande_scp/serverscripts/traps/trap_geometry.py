"""Trap location estimator — the pure rules. No frappe import; plain pytest.

A trap is a fixed object, so every scouting entry recorded at it is a GPS fix
of the same spot. The estimate is a robust centre of those fixes:

    1. keep fixes whose reported accuracy is <= MAX_ACCURACY_M
    2. per-coordinate median
    3. drop fixes more than OUTLIER_M from that median, recompute the median
    4. need at least MIN_FIXES kept fixes, else no estimate
    5. spread = p90 distance of the kept fixes from the estimate

Distances use a local equirectangular projection around the point — exact to
well under a centimetre at the tens-of-metres scale a farm works at.
"""

import json
import math

MAX_ACCURACY_M = 5.0
OUTLIER_M = 15.0
MIN_FIXES = 3
# How far from its house a trap may sit before it is flagged. Outdoor traps
# legitimately hang outside the house, so they get a looser limit.
FLAG_INDOOR_M = 30.0
FLAG_OUTDOOR_M = 100.0
FLAG_LABEL = "outside house"

_EARTH_R = 6371008.8  # mean Earth radius, metres


def median(values):
    s = sorted(values)
    n = len(s)
    if not n:
        raise ValueError("median of empty sequence")
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2.0


def percentile(values, p):
    """Linear-interpolated percentile, p in [0, 100]."""
    s = sorted(values)
    if not s:
        return 0.0
    if len(s) == 1:
        return float(s[0])
    k = (len(s) - 1) * (p / 100.0)
    lo = math.floor(k)
    hi = math.ceil(k)
    if lo == hi:
        return float(s[lo])
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def _to_xy(lat0, lng0, lat, lng):
    """Metres east/north of (lat0, lng0)."""
    x = math.radians(lng - lng0) * math.cos(math.radians(lat0)) * _EARTH_R
    y = math.radians(lat - lat0) * _EARTH_R
    return x, y


def distance_m(lat1, lng1, lat2, lng2):
    x, y = _to_xy(lat1, lng1, lat2, lng2)
    return math.hypot(x, y)


def estimate(fixes, max_accuracy=MAX_ACCURACY_M, outlier_m=OUTLIER_M, min_fixes=MIN_FIXES):
    """fixes: iterable of (lat, lng, accuracy_m). Returns a dict
    {lat, lng, fixes, spread_m, dropped} or None when too few fixes survive."""
    pts = []
    for f in fixes:
        try:
            lat, lng, acc = float(f[0]), float(f[1]), float(f[2])
        except (TypeError, ValueError, IndexError):
            continue
        if not (math.isfinite(lat) and math.isfinite(lng) and math.isfinite(acc)):
            continue
        if abs(lat) < 1e-3 and abs(lng) < 1e-3:  # (0,0) is the Atlantic
            continue
        if acc <= 0 or acc > max_accuracy:
            continue
        pts.append((lat, lng))
    if len(pts) < min_fixes:
        return None
    mlat = median(p[0] for p in pts)
    mlng = median(p[1] for p in pts)
    kept = [p for p in pts if distance_m(mlat, mlng, p[0], p[1]) <= outlier_m]
    if len(kept) < min_fixes:
        return None
    lat = median(p[0] for p in kept)
    lng = median(p[1] for p in kept)
    spread = percentile([distance_m(lat, lng, p[0], p[1]) for p in kept], 90)
    return {
        "lat": lat,
        "lng": lng,
        "fixes": len(kept),
        "dropped": len(pts) - len(kept),
        "spread_m": round(spread, 2),
    }


# ── distance to a house's geometry ──────────────────────────────────────────

def _seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _point_in_ring(px, py, ring):
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > py) != (y2 > py):
            xi = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
            if px < xi:
                inside = not inside
    return inside


def _geometries(geo):
    """Yield the bare geometries in a GeoJSON value (str/dict, any wrapper)."""
    if isinstance(geo, str):
        try:
            geo = json.loads(geo)
        except ValueError:
            return
    if not isinstance(geo, dict):
        return
    t = geo.get("type")
    if t == "FeatureCollection":
        for f in geo.get("features") or []:
            yield from _geometries(f)
    elif t == "Feature":
        yield from _geometries(geo.get("geometry"))
    elif t == "GeometryCollection":
        for g in geo.get("geometries") or []:
            yield from _geometries(g)
    elif t:
        yield geo


def distance_to_geometries(lat, lng, geos):
    """Shortest distance (m) from the point to any line/polygon in `geos`
    (0 when inside a polygon). None when there is no usable geometry."""
    best = None

    def take(d):
        nonlocal best
        best = d if best is None or d < best else best

    def line(coords):
        xy = [_to_xy(lat, lng, c[1], c[0]) for c in coords if len(c) >= 2]
        if len(xy) == 1:
            take(math.hypot(*xy[0]))
        for a, b in zip(xy, xy[1:]):
            take(_seg_dist(0.0, 0.0, a[0], a[1], b[0], b[1]))
        return xy

    for raw in geos:
        for g in _geometries(raw):
            t, c = g.get("type"), g.get("coordinates") or []
            try:
                if t == "Point":
                    line([c])
                elif t in ("LineString", "MultiPoint"):
                    line(c)
                elif t == "MultiLineString":
                    for part in c:
                        line(part)
                elif t in ("Polygon", "MultiPolygon"):
                    polys = [c] if t == "Polygon" else c
                    for poly in polys:
                        if not poly:
                            continue
                        outer = line(poly[0])
                        for hole in poly[1:]:
                            line(hole)
                        if outer and _point_in_ring(0.0, 0.0, outer):
                            take(0.0)
            except (TypeError, ValueError, IndexError):
                continue
    return best


def flag_for(distance, location):
    """The location_flag for a trap `distance` metres from its house."""
    if distance is None:
        return ""
    limit = FLAG_OUTDOOR_M if (location or "") == "Outdoor" else FLAG_INDOOR_M
    return FLAG_LABEL if distance > limit else ""


def to_geojson(lat, lng, properties=None):
    """The trap's stored value: a FeatureCollection holding one Point — the
    same wrapper Zone.geojson uses, and what a Geolocation field renders."""
    return {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": dict(properties or {}),
            "geometry": {"type": "Point", "coordinates": [round(lng, 8), round(lat, 8)]},
        }],
    }


def point_of(geo):
    """(lat, lng) of the first Point in a stored trap geojson, or None."""
    for g in _geometries(geo):
        if g.get("type") == "Point":
            c = g.get("coordinates") or []
            try:
                return float(c[1]), float(c[0])
            except (TypeError, ValueError, IndexError):
                return None
    return None
