"""Spread — patches of neighbouring infested stations, how they changed since
the previous scouted week, and the geometry and figures pins need.

Spec: docs/superpowers/specs/2026-10-10-spread-and-pins-design.md (C1–C3, C7, C8, §2).

* A **patch** (cluster) is a connected set of infested stations of one house,
  one ISO week and one observation. Two stations touch when their group ranks
  (bed / orchard row) differ by at most 1 **and** their ranks within the group
  (zone / tree) differ by at most 1: 8-neighbour on the rank grid (C1). No GPS.
* Only patches of ``MIN_SIZE`` (3) or more stations count, and the ``TOP_N`` (5)
  largest are reported (C2).
* ``track`` matches each patch with the previous scouted week's: by shared
  stations first, else by a centroid within ``MATCH_RANKS`` (2) ranks on both
  axes (C3).
* ``share`` / ``pin_rises`` are a pin's weekly figure and its notice rule (C7, C8).
* ``point_in_polygon`` / ``geometry_centroid`` resolve an area pin to its
  stations; every point is (lng, lat), GeoJSON order. Ray casting, always: the
  same answer on every site whether or not shapely is installed.

No frappe import: this runs under plain pytest.
"""

import json

MIN_SIZE = 3
TOP_N = 5
MATCH_RANKS = 2
GROW_SHARE = 0.25
GROW_MIN = 3
PIN_MIN_SCOUTED = 5
PIN_RISE_POINTS = 10

NEW, GREW, SHRANK, MOVED, STABLE, GONE = "New", "Grew", "Shrank", "Moved", "Stable", "Gone"
CHANGES = (NEW, GREW, SHRANK, MOVED, STABLE, GONE)

_NEIGHBOURS = tuple((dr, dc) for dr in (-1, 0, 1) for dc in (-1, 0, 1) if dr or dc)
_UNITS = {"bed": ("bed", "zone"), "row": ("row", "tree")}


# ── patches (C1, C2) ───────────────────────────────────────────────────────


def _root(parent: dict, x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


def components(ranks: dict, infested) -> list:
    """Connected sets (C1) of the ``infested`` stations that have a rank;
    stations without one (not set up in the house) are ignored."""
    at: dict = {}
    for station in sorted(set(infested or ())):
        pos = ranks.get(station)
        if pos is not None:
            at[(int(pos[0]), int(pos[1]))] = station
    parent = {station: station for station in at.values()}
    for (r, c), station in at.items():
        for dr, dc in _NEIGHBOURS:
            other = at.get((r + dr, c + dc))
            if other is None:
                continue
            a, b = _root(parent, station), _root(parent, other)
            if a != b:
                parent[max(a, b)] = min(a, b)
    groups: dict = {}
    for station in parent:
        groups.setdefault(_root(parent, station), set()).add(station)
    return list(groups.values())


def _sort_key(c) -> tuple:
    return (-c["size"], c["rows"][0], c["cols"][0], c["stations"][0])


def _shape(stations, ranks) -> dict:
    pts = [ranks[s] for s in stations]
    rows = [int(p[0]) for p in pts]
    cols = [int(p[1]) for p in pts]
    return {
        "stations": sorted(stations),
        "size": len(pts),
        "centroid": (round(sum(rows) / len(pts), 2), round(sum(cols) / len(pts), 2)),
        "rows": (min(rows), max(rows)),
        "cols": (min(cols), max(cols)),
    }


def clusters(ranks: dict, infested, limit=TOP_N) -> list:
    """Patches of ≥ MIN_SIZE stations, largest first (ties: nearest the front
    of the house, then by name), at most ``limit`` (None = every patch)."""
    found = [_shape(g, ranks) for g in components(ranks, infested) if len(g) >= MIN_SIZE]
    found.sort(key=_sort_key)
    return found if limit is None else found[:limit]


# ── week to week (C3) ──────────────────────────────────────────────────────


def _distance(a, b) -> float:
    """Rank-space distance: the larger of the two axis differences, the same
    metric the 8-neighbour rule uses."""
    return max(abs(a[0] - b[0]), abs(a[1] - b[1]))


def change_of(size, prev_size, overlap) -> str:
    """C3 for a matched patch: Moved when it was matched only by centroid;
    else Grew / Shrank on a change of at least 25 % **and** at least 3
    stations; else Stable."""
    if not overlap:
        return MOVED
    delta = size - prev_size
    if delta >= GROW_MIN and delta >= GROW_SHARE * prev_size:
        return GREW
    if -delta >= GROW_MIN and -delta >= GROW_SHARE * prev_size:
        return SHRANK
    return STABLE


def track(current, previous, gone_limit=TOP_N) -> tuple:
    """``(current with change + prev_size, gone)`` (C3).

    Each current patch takes the previous patch it shares the most stations
    with (ties: the nearer centroid, then the earlier one). Failing any overlap,
    it takes the previous patch whose centroid is nearest, within MATCH_RANKS.
    Several current patches may take the same previous one (a patch that
    split). A previous patch nobody took is Gone: at most ``gone_limit``,
    largest first. Pass ``previous`` uncapped (``clusters(..., limit=None)``)
    so a small patch that was sixth last week still matches."""
    previous = list(previous or ())
    prev_sets = [set(p["stations"]) for p in previous]
    taken: set = set()
    out = []
    for c in current or ():
        mine = set(c["stations"])
        best, best_key = None, None
        for i, p in enumerate(previous):
            shared = len(mine & prev_sets[i])
            dist = _distance(c["centroid"], p["centroid"])
            if shared:
                key = (0, -shared, dist, i)
            elif dist <= MATCH_RANKS:
                key = (1, 0, dist, i)
            else:
                continue
            if best_key is None or key < best_key:
                best, best_key = i, key
        if best is None:
            out.append({**c, "change": NEW, "prev_size": None})
            continue
        taken.add(best)
        prev_size = previous[best]["size"]
        out.append({**c, "change": change_of(c["size"], prev_size, best_key[0] == 0), "prev_size": prev_size})
    gone = sorted((p for i, p in enumerate(previous) if i not in taken), key=_sort_key)
    if gone_limit is not None:
        gone = gone[:gone_limit]
    return out, [{**p, "change": GONE, "prev_size": p["size"]} for p in gone]


def _span(noun, lo, hi) -> str:
    if lo == hi:
        return f"{noun} {lo + 1}"
    return f"{noun}s {lo + 1}–{hi + 1}"


def label(cluster, unit="bed") -> str:
    """``beds 20–24, zones 3–7`` / ``rows 4–6, trees 10–15``: 1-based rank
    positions, which are the bed / zone numbers where a house numbers them 1…N."""
    group, member = _UNITS.get(unit, _UNITS["bed"])
    return f"{_span(group, *cluster['rows'])}, {_span(member, *cluster['cols'])}"


# ── geometry for area pins ─────────────────────────────────────────────────


def parse_geojson(value):
    """A GeoJSON dict from a dict or a JSON string; None for anything else."""
    if isinstance(value, dict):
        return value
    if not value or not isinstance(value, str):
        return None
    try:
        out = json.loads(value)
    except ValueError:
        return None
    return out if isinstance(out, dict) else None


def polygons(geom) -> list:
    """A Polygon, a MultiPolygon or a Feature of either → ``[[outer, hole, …], …]``
    with every ring a list of (lng, lat) of ≥ 3 points; ``[]`` when there is none."""
    geom = parse_geojson(geom)
    if not geom:
        return []
    if geom.get("type") == "Feature":
        return polygons(geom.get("geometry"))
    coords = geom.get("coordinates") or []
    if geom.get("type") == "Polygon":
        polys = [coords]
    elif geom.get("type") == "MultiPolygon":
        polys = list(coords)
    else:
        return []
    out = []
    try:
        for poly in polys:
            if not poly or len(poly[0]) < 3:
                continue
            out.append([[(float(p[0]), float(p[1])) for p in ring] for ring in poly if len(ring) >= 3])
    except (TypeError, ValueError, IndexError):
        return []
    return out


def _in_ring(x, y, ring) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _in_polys(x, y, polys) -> bool:
    return any(_in_ring(x, y, rings[0]) and not any(_in_ring(x, y, h) for h in rings[1:]) for rings in polys)


def point_in_polygon(point, geom) -> bool:
    """Ray casting. ``point`` is (lng, lat), GeoJSON order: inside the outer
    ring of some polygon and inside none of its holes."""
    return _in_polys(float(point[0]), float(point[1]), polygons(geom))


def stations_in_polygon(centroids: dict, geom) -> list:
    """The stations whose (lng, lat) centroid lies inside ``geom``, sorted."""
    polys = polygons(geom)
    if not polys:
        return []
    return sorted(s for s, (x, y) in centroids.items() if _in_polys(float(x), float(y), polys))


def _vertices(geom) -> list:
    kind = geom.get("type")
    if kind == "Feature":
        return _vertices(geom.get("geometry") or {})
    if kind == "FeatureCollection":
        out = []
        for f in geom.get("features") or ():
            out += _vertices(f or {})
        return out
    coords = geom.get("coordinates")
    if kind == "Point":
        return [coords] if coords else []
    if kind == "LineString":
        return list(coords or ())
    if kind == "Polygon":
        return list((coords or [[]])[0])
    if kind == "MultiPolygon":
        return list(((coords or [[[]]])[0] or [[]])[0])
    return []


def geometry_centroid(geom):
    """(lng, lat): the mean of every vertex. That is a zone's bed-line points,
    a polygon's outer ring or a tree's point, matching the frontend's
    ``geometryCentroid``. None when there is nothing to average."""
    geom = parse_geojson(geom)
    if not geom:
        return None
    try:
        pts = [(float(p[0]), float(p[1])) for p in _vertices(geom)]
    except (TypeError, ValueError, IndexError):
        return None
    if not pts:
        return None
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


# ── pins (C7, C8) ──────────────────────────────────────────────────────────


def share(stations, scouted, infested, min_n=PIN_MIN_SCOUTED) -> dict:
    """C7: infested ÷ scouted among the pin's stations, as a 0–100 figure
    (1 dp). ``value`` is None (and ``thin`` True) below ``min_n`` scouted."""
    mine = set(stations or ())
    seen = mine & set(scouted or ())
    hit = seen & set(infested or ())
    n = len(seen)
    return {
        "scouted": n,
        "infested": len(hit),
        "value": round(100.0 * len(hit) / n, 1) if n >= min_n else None,
        "thin": n < min_n,
    }


def pin_rises(before, now) -> bool:
    """C8: up by at least PIN_RISE_POINTS with ≥ PIN_MIN_SCOUTED scouted both
    weeks (a thin week has no value)."""
    if not before or not now:
        return False
    if before.get("value") is None or now.get("value") is None:
        return False
    return now["value"] - before["value"] >= PIN_RISE_POINTS - 1e-9
