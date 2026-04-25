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


def wipe_all():
    """Delete every Orchard Tree and every Row-typed Bed across all blocks.

    Avocado-only — does not touch rose beds (unit_type=Bed). Use this to
    start from a clean orchard slate before re-importing.
    """
    trees = frappe.get_all("Orchard Tree", pluck="name")
    for t in trees:
        frappe.delete_doc("Orchard Tree", t, force=True, ignore_permissions=True)

    rows = frappe.get_all(
        "Bed",
        filters={"unit_type": "Row"},
        pluck="name",
    )
    for r in rows:
        frappe.delete_doc("Bed", r, force=True, ignore_permissions=True)

    frappe.db.commit()
    return f"Deleted {len(trees)} Orchard Trees and {len(rows)} Row beds (all blocks)."


def wipe_all_fast():
    """Raw-SQL wipe of all Orchard Trees + Row beds. Bypasses hooks for speed.

    Manually invalidates the per-block and per-farm Redis caches that the
    `invalidate_orchard_trees_for_doc` hook would have cleared had we gone
    through the ORM path.
    """
    tree_count = frappe.db.count("Orchard Tree")
    row_count = frappe.db.count("Bed", {"unit_type": "Row"})

    # Capture affected blocks + farms BEFORE deletion so we can target caches.
    blocks = frappe.db.sql_list(
        "SELECT DISTINCT block FROM `tabOrchard Tree` WHERE block IS NOT NULL AND block != ''"
    )
    farms = []
    if blocks:
        placeholders = ",".join(["%s"] * len(blocks))
        farms = frappe.db.sql_list(
            f"""
            SELECT DISTINCT custom_farm FROM `tabWarehouse`
            WHERE name IN ({placeholders})
              AND custom_farm IS NOT NULL AND custom_farm != ''
            """,
            tuple(blocks),
        )

    # Wipe.
    frappe.db.sql("DELETE FROM `tabOrchard Tree`")
    frappe.db.sql("DELETE FROM `tabBed` WHERE unit_type = 'Row'")
    frappe.db.commit()

    # Nuke the Redis keys the doc_event hook would have cleared.
    from upande_scp.serverscripts.cache_utils import K_ORCHARD_TREES_PREFIX, invalidate

    keys = [f"{K_ORCHARD_TREES_PREFIX}:{b}" for b in blocks]
    keys += [f"{K_ORCHARD_TREES_PREFIX}:farm:{f}" for f in farms]
    if keys:
        invalidate(*keys)

    return (
        f"Wiped {tree_count} Orchard Trees and {row_count} Row beds. "
        f"Cleared {len(blocks)} block caches and {len(farms)} farm caches."
    )
