"""Put the avocado block boundaries back on sites that lost them.

`Warehouse.custom_raw_geojson` holds one Polygon per Block — the hull the
avocado map draws, carrying `area_m2`, `tree_count` and `block_code` in its
properties. Every read of block geometry goes through `build_blocks_geojson`,
which parses that column and skips a block that has none.

**It is empty on every warehouse on the live v16 site** — all 142 Blocks, all
127 Greenhouses, every type. It is populated on the v15-era data for all 78
Lokitela blocks, so it did not survive the v15→v16 migration; nothing in the
scouting transfer carried it. The symptom is quiet, which is why it went
unnoticed: `get_blocks_geojson` returns a well-formed but empty
FeatureCollection, so the avocado map renders "0 blocks" and simply draws no
polygons rather than reporting a fault. The jobsheet's "prescribe a block from
the map" has nothing to click on the site the operators actually use.

The data is small — 78 polygons averaging eight points, 58 KB — so it ships in
the app (`data/block_boundaries.json`) and is restored here rather than being
chased through another data migration.

**Never overwrites.** A block that already carries geometry is left exactly as
it is; this only fills blanks. That makes it safe to re-run and safe on the site
the data was exported FROM, and it means a boundary someone has since corrected
by hand is not silently reverted to the export.

`custom_area_ha` is filled the same way and for the same reason: it is the
denominator for per-hectare pest thresholds, and a block with a boundary but no
area would still be unreportable.
"""

import json
import os

import frappe


def _data_path() -> str:
    # upande_scp/patches/v1_0/<this file> → upande_scp/data/block_boundaries.json
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(os.path.dirname(here)), "data", "block_boundaries.json")


def execute():
    path = _data_path()
    if not os.path.exists(path):
        frappe.log_error(
            f"restore_block_boundaries: {path} is missing", "SCP block boundaries"
        )
        return

    with open(path) as fh:
        blocks = json.load(fh)

    if not frappe.db.has_column("Warehouse", "custom_raw_geojson"):
        # The custom field is created by this app's own fixtures; if it is not
        # there yet the site is mid-install and there is nothing to fill.
        return

    filled_geo, filled_area, absent = 0, 0, []
    for name, payload in blocks.items():
        if not frappe.db.exists("Warehouse", name):
            absent.append(name)
            continue

        current_geo, current_area = frappe.db.get_value(
            "Warehouse", name, ["custom_raw_geojson", "custom_area_ha"]
        )

        if not (current_geo or "").strip():
            frappe.db.set_value(
                "Warehouse",
                name,
                "custom_raw_geojson",
                json.dumps(payload["geojson"], separators=(",", ":")),
                update_modified=False,
            )
            filled_geo += 1

        area = float(payload.get("area_ha") or 0)
        if area and not float(current_area or 0):
            frappe.db.set_value(
                "Warehouse", name, "custom_area_ha", area, update_modified=False
            )
            filled_area += 1

    frappe.db.commit()

    # The parsed FeatureCollection is cached for a day, so a site that has just
    # been filled would keep serving the empty one it built earlier.
    from upande_scp.serverscripts.common.cache_utils import K_BLOCKS_GEOJSON

    frappe.cache().delete_value(K_BLOCKS_GEOJSON)

    frappe.logger().info(
        f"restore_block_boundaries: geometry {filled_geo}, area {filled_area}, "
        f"{len(absent)} named blocks absent on this site"
    )
