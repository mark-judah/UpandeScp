"""Per-block Orchard Tree FeatureCollection for the scouts map's avocado view.

Cached in Redis with the same TTL as zone GeoJSON (TTL_LONG); invalidated by
`invalidate_orchard_trees_for_doc` on every Orchard Tree save/delete via the
hooks.py wiring.
"""

import json
import math

import frappe

from upande_scp.serverscripts.cache_utils import (
    K_ORCHARD_TREES_PREFIX,
    TTL_LONG,
    get_or_set,
)


POS_TOL_M = 1.5  # a row is "linear" if even interpolation reproduces every tree within this many metres


def _strip_trailing_int(name, n):
    """``name`` with the trailing ``str(n)`` removed, or ``None`` if it doesn't end with it."""
    suffix = str(n)
    if name and name.endswith(suffix):
        return name[: len(name) - len(suffix)]
    return None


def _interp_max_error_m(coords):
    """Max distance (metres) between each tree and its even-interpolation along the
    endpoint line. ``coords`` is ``[(lng, lat), …]`` in tree order, ``len >= 2``."""
    a = coords[0]
    b = coords[-1]
    n = len(coords)
    mlng = 111320.0 * math.cos(math.radians(a[1]))
    mlat = 111320.0
    bx = (b[0] - a[0]) * mlng
    by = (b[1] - a[1]) * mlat
    maxerr = 0.0
    for i, p in enumerate(coords):
        f = i / (n - 1)
        ex = bx * f
        ey = by * f
        px = (p[0] - a[0]) * mlng
        py = (p[1] - a[1]) * mlat
        d = math.hypot(px - ex, py - ey)
        if d > maxerr:
            maxerr = d
    return maxerr


def _row_payload(names, coords):
    """Build one row dict from parallel ``names`` + ``coords`` (tree order, 1..N).

    LINEAR (``k="l"``) when the names fit the ``<prefix><n>`` pattern and even
    interpolation reproduces the row within ``POS_TOL_M``; EXPLICIT (``k="e"``)
    otherwise (obstacle rows, odd names, single tree).
    """
    n = len(coords)
    if n == 0:
        return None
    if n == 1:
        return {"k": "e", "c": [coords[0][0], coords[0][1]], "n": 1, "names": [names[0]]}
    prefix = _strip_trailing_int(names[0], 1)
    good_prefix = prefix is not None and names[-1] == f"{prefix}{n}"
    if good_prefix and _interp_max_error_m(coords) <= POS_TOL_M:
        a = coords[0]
        b = coords[-1]
        return {"k": "l", "p": prefix, "a": [a[0], a[1]], "b": [b[0], b[1]], "n": n}
    flat = []
    for c in coords:
        flat.append(c[0])
        flat.append(c[1])
    row = {"k": "e", "c": flat, "n": n}
    if good_prefix:
        row["p"] = prefix
    else:
        row["names"] = list(names)
    return row


def _coord_from_geojson(raw):
    """Extract (lng, lat) from GeoJSON raw string, or None if unparseable."""
    try:
        feat = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if isinstance(feat, dict) and feat.get("type") == "FeatureCollection":
        feat = (feat.get("features") or [None])[0]
    if not isinstance(feat, dict):
        return None
    c = (feat.get("geometry") or {}).get("coordinates")
    if isinstance(c, (list, tuple)) and len(c) >= 2:
        return (c[0], c[1])
    return None


def _tree_num(t):
    """Extract integer tree_number from a tree record, default 0 if invalid."""
    try:
        return int(t.tree_number)
    except (TypeError, ValueError):
        return 0


def _rows_from_trees(tree_rows):
    """Group tree records by (block, row), order each by integer tree_number,
    extract name+coord, call _row_payload, return {"rows": [...]}.

    Skips trees with unparseable geojson.
    """
    from collections import defaultdict

    groups = defaultdict(list)
    for t in tree_rows:
        groups[(t.block, t.row)].append(t)

    out = []
    for key in groups:
        trees = sorted(groups[key], key=_tree_num)
        names = []
        coords = []
        for t in trees:
            c = _coord_from_geojson(t.raw_geojson)
            if c is None:
                continue
            names.append(t.name)
            coords.append(c)
        row = _row_payload(names, coords)
        if row:
            out.append(row)
    return {"rows": out}


def _features_from_trees(tree_rows):
    features = []
    for t in tree_rows:
        try:
            feat = json.loads(t.raw_geojson)
        except (TypeError, ValueError):
            continue
        if not isinstance(feat, dict):
            continue
        # If the stored blob is a FeatureCollection, take its first feature.
        if feat.get("type") == "FeatureCollection":
            sub = (feat.get("features") or [None])[0]
            if not sub:
                continue
            feat = sub
        props = feat.setdefault("properties", {})
        props["tree_name"] = t.name
        props["tree_code"] = t.tree_code
        props["row"] = t.row
        props["tree_number"] = t.tree_number
        props["block"] = t.block
        features.append(feat)
    return features


def _build_for_block(block):
    trees = frappe.get_all(
        "Orchard Tree",
        filters={"block": block, "geojson": ["is", "set"]},
        fields=["name", "tree_number", "row", "tree_code", "block", "geojson as raw_geojson"],
        order_by="row asc, tree_number asc",
        limit_page_length=0,
    )
    return {"type": "FeatureCollection", "features": _features_from_trees(trees)}


def _build_for_farm(farm):
    blocks = frappe.get_all(
        "Warehouse",
        filters={
            "custom_farm": farm,
            "warehouse_type": ["in", ["Block", "Greenhouse"]],
            "disabled": 0,
        },
        pluck="name",
    )
    if not blocks:
        return {"type": "FeatureCollection", "features": []}
    trees = frappe.get_all(
        "Orchard Tree",
        filters={"block": ["in", blocks], "geojson": ["is", "set"]},
        fields=["name", "tree_number", "row", "tree_code", "block", "geojson as raw_geojson"],
        order_by="block asc, row asc, tree_number asc",
        limit_page_length=0,
    )
    return {"type": "FeatureCollection", "features": _features_from_trees(trees)}


@frappe.whitelist()
def get_orchard_trees_geojson(block=None, farm=None):
    block = block or frappe.form_dict.get("block")
    farm = farm or frappe.form_dict.get("farm")

    if block:
        return get_or_set(
            f"{K_ORCHARD_TREES_PREFIX}:{block}",
            lambda: _build_for_block(block),
            ttl=TTL_LONG,
        )
    if farm:
        return get_or_set(
            f"{K_ORCHARD_TREES_PREFIX}:farm:{farm}",
            lambda: _build_for_farm(farm),
            ttl=TTL_LONG,
        )
    return {"type": "FeatureCollection", "features": []}


# ── Lean "points" variant ────────────────────────────────────────────────
# The 3D map only needs each tree's coordinate + name (for per-scout colour).
# Returning parallel arrays instead of a FeatureCollection of ~50k nested
# features shrinks the payload several-fold and skips all the per-feature
# object churn on both ends.


def _points_from_trees(tree_rows):
    names = []
    coords = []  # flat [lng0, lat0, lng1, lat1, …]
    for t in tree_rows:
        try:
            feat = json.loads(t.raw_geojson)
        except (TypeError, ValueError):
            continue
        if isinstance(feat, dict) and feat.get("type") == "FeatureCollection":
            feat = (feat.get("features") or [None])[0]
        if not isinstance(feat, dict):
            continue
        c = (feat.get("geometry") or {}).get("coordinates")
        if not (isinstance(c, (list, tuple)) and len(c) >= 2):
            continue
        names.append(t.name)
        coords.append(c[0])
        coords.append(c[1])
    return {"names": names, "coords": coords}


def _points_for_block(block):
    trees = frappe.get_all(
        "Orchard Tree",
        filters={"block": block, "geojson": ["is", "set"]},
        fields=["name", "geojson as raw_geojson"],
        order_by="row asc, tree_number asc",
        limit_page_length=0,
    )
    return _points_from_trees(trees)


def _points_for_farm(farm):
    blocks = frappe.get_all(
        "Warehouse",
        filters={
            "custom_farm": farm,
            "warehouse_type": ["in", ["Block", "Greenhouse"]],
            "disabled": 0,
        },
        pluck="name",
    )
    if not blocks:
        return {"names": [], "coords": []}
    trees = frappe.get_all(
        "Orchard Tree",
        filters={"block": ["in", blocks], "geojson": ["is", "set"]},
        fields=["name", "geojson as raw_geojson"],
        order_by="block asc, row asc, tree_number asc",
        limit_page_length=0,
    )
    return _points_from_trees(trees)


@frappe.whitelist()
def get_orchard_tree_points(block=None, farm=None):
    block = block or frappe.form_dict.get("block")
    farm = farm or frappe.form_dict.get("farm")
    if block:
        return get_or_set(
            f"{K_ORCHARD_TREES_PREFIX}:pts:{block}",
            lambda: _points_for_block(block),
            ttl=TTL_LONG,
        )
    if farm:
        return get_or_set(
            f"{K_ORCHARD_TREES_PREFIX}:pts:farm:{farm}",
            lambda: _points_for_farm(farm),
            ttl=TTL_LONG,
        )
    return {"names": [], "coords": []}
