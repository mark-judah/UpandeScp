"""CLI helper for `Tree And Row Automation`.

Lets you trigger the automation against a block from the bench shell, e.g.

    bench --site kaitet.local execute \\
        upande_scp.serverscripts.run_tree_automation.run_from_file \\
        --kwargs '{"block":"DAIRY BLK 6 - KL","geojson_path":"/tmp/blk6.geojson"}'

Reuses the existing `Tree And Row Automation` document for the block when one
already exists (autoname is `field:block`, so the doc name is the block name).
"""

import frappe


def run_from_file(block, geojson_path, sectors=None):
    """Load a GeoJSON file, attach it to the block's automation doc, run it.

    Returns the human-readable summary string from `run_automation`.
    """
    with open(geojson_path) as f:
        payload = f.read()

    if frappe.db.exists("Tree And Row Automation", block):
        doc = frappe.get_doc("Tree And Row Automation", block)
        doc.trees_geojson = payload
        if sectors is not None:
            doc.set("sectors", sectors)
        doc.save(ignore_permissions=True)
    else:
        doc = frappe.get_doc(
            {
                "doctype": "Tree And Row Automation",
                "block": block,
                "trees_geojson": payload,
                "sectors": sectors or [],
            }
        )
        doc.insert(ignore_permissions=True)

    result = doc.run_automation()
    frappe.db.commit()
    return result


def wipe_block(block):
    """Delete all Orchard Trees + Row beds for a block (avocado-only data).

    Leaves rose beds (unit_type=Bed) untouched. Returns a summary string.
    """
    trees = frappe.get_all("Orchard Tree", filters={"block": block}, pluck="name")
    for t in trees:
        frappe.delete_doc("Orchard Tree", t, force=True, ignore_permissions=True)

    rows = frappe.get_all(
        "Bed",
        filters={"greenhouse": block, "unit_type": "Row"},
        pluck="name",
    )
    for r in rows:
        frappe.delete_doc("Bed", r, force=True, ignore_permissions=True)

    frappe.db.commit()
    return f"Deleted {len(trees)} Orchard Trees and {len(rows)} Row beds for {block}."
