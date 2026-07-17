"""Per-block Orchard Tree FeatureCollection for the scouts map's avocado view.

Cached in Redis with the same TTL as zone GeoJSON (TTL_LONG); invalidated by
`invalidate_orchard_trees_for_doc` on every Orchard Tree save/delete via the
hooks.py wiring.
"""

import json

import frappe

from upande_scp.serverscripts.cache_utils import (
    K_ORCHARD_TREES_PREFIX,
    TTL_LONG,
    get_or_set,
)


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
