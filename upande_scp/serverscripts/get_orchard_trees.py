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
        filters={"block": block, "raw_geojson": ["is", "set"]},
        fields=["name", "tree_number", "row", "tree_code", "block", "raw_geojson"],
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
        filters={"block": ["in", blocks], "raw_geojson": ["is", "set"]},
        fields=["name", "tree_number", "row", "tree_code", "block", "raw_geojson"],
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
