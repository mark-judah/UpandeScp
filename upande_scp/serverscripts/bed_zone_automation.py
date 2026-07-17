"""Bed & Zone automation — create Bed/Zone records from a Bed And Zone
Automation doc's zone GeoJSON.

Ported verbatim from the legacy "Zone Atomation Tool" API Server Script
(api_method ``createBedsAndZones``) into versioned code. Driven by the
"Bed And Zone Automation Tool" desk form script (public/js/
bed_and_zone_automation.js), which calls ``create_beds_and_zones`` with the
document name and shows the returned summary.
"""

import json

import frappe


def _assign_variety_from_sectors(sectors, bed_number):
    try:
        bed_int = int(bed_number)
    except Exception:
        return None
    for sector in sectors:
        try:
            if int(sector.from_bed) <= bed_int <= int(sector.to_bed):
                return sector.sector
        except Exception:
            continue
    return None


def _safe_parse_json(json_string):
    """Parse a JSON string, surfacing errors as user-facing throws."""
    if not json_string:
        return {}
    try:
        return json.loads(json_string)
    except json.JSONDecodeError as e:
        frappe.throw(f"Invalid JSON format: {e}")
    except Exception as e:
        frappe.throw(f"Error parsing JSON: {e}")


@frappe.whitelist()
def create_beds_and_zones(doc_name=None):
    """Create Bed and Zone records for the given Bed And Zone Automation doc.

    Idempotent: existing Bed/Zone rows (matched on greenhouse + bed [+ zone])
    are skipped. Returns a human-readable summary string the desk form script
    shows via ``frappe.msgprint``.
    """
    if not doc_name:
        frappe.throw(
            "Error: Document name is missing. Please save the document and try again."
        )

    try:
        doc = frappe.get_doc("Bed And Zone Automation", doc_name)
        beds_created_count = 0
        zones_created_count = 0
        skipped_beds_count = 0
        skipped_zones_count = 0

        greenhouse = doc.name
        zones_geojson = doc.zones_geojson or ""
        sectors = doc.sectors or []

        for line in zones_geojson.strip().splitlines():
            if not line.strip():
                continue

            feature_collection = _safe_parse_json(line)
            if not feature_collection:
                continue

            for feature in feature_collection.get("features", []):
                props = feature.get("properties", {})
                bed_number = str(props.get("line_id"))
                zone_number = str(props.get("zone_id"))

                if not bed_number or not zone_number:
                    continue

                variety = _assign_variety_from_sectors(sectors, bed_number)

                # --- Bed ---
                existing_bed_name = frappe.db.exists({
                    "doctype": "Bed",
                    "greenhouse": greenhouse,
                    "bed": bed_number,
                })

                bed_doc = None
                if existing_bed_name:
                    skipped_beds_count += 1
                    bed_doc = frappe.get_doc("Bed", existing_bed_name)
                else:
                    try:
                        bed_doc = frappe.get_doc({
                            "doctype": "Bed",
                            "greenhouse": greenhouse,
                            "bed": bed_number,
                            "variety": variety or "",
                        })
                        bed_doc.insert(ignore_permissions=True)
                        beds_created_count += 1
                    except Exception as e:
                        frappe.log_error(f"Failed to create Bed: {e}", "Bed And Zone Automation Error")
                        continue

                if not bed_doc:
                    continue

                # --- Zone ---
                existing_zone_name = frappe.db.exists({
                    "doctype": "Zone",
                    "greenhouse": greenhouse,
                    "bed": bed_doc.name,
                    "zone": zone_number,
                })

                if existing_zone_name:
                    skipped_zones_count += 1
                else:
                    try:
                        zone_doc = frappe.get_doc({
                            "doctype": "Zone",
                            "greenhouse": greenhouse,
                            "bed": bed_doc.name,
                            "zone": zone_number,
                            "raw_geojson": line,
                        })
                        zone_doc.insert(ignore_permissions=True)
                        zones_created_count += 1
                    except Exception as e:
                        frappe.log_error(f"Failed to create Zone: {e}", "Bed And Zone Automation Error")

        return (
            f"{beds_created_count} beds created, {skipped_beds_count} skipped. "
            f"{zones_created_count} zones created, {skipped_zones_count} skipped."
        )

    except Exception as e:
        frappe.throw(f"Error in Bed & Zone Automation: {e}")
