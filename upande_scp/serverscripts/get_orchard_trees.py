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


def _build_orchard_trees(block):
    trees = frappe.get_all(
        "Orchard Tree",
        filters={"block": block, "raw_geojson": ["is", "set"]},
        fields=["name", "tree_number", "row", "tree_code", "raw_geojson"],
        order_by="row asc, tree_number asc",
        limit_page_length=0,
    )
    features = []
    for t in trees:
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
        features.append(feat)
    return {"type": "FeatureCollection", "features": features}


@frappe.whitelist()
def get_orchard_trees_geojson(block=None):
    block = block or frappe.form_dict.get("block")
    if not block:
        return {"type": "FeatureCollection", "features": []}

    return get_or_set(
        f"{K_ORCHARD_TREES_PREFIX}:{block}",
        lambda: _build_orchard_trees(block),
        ttl=TTL_LONG,
    )
