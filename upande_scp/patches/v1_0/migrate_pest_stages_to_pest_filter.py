"""Move pest stages from the Pest doctype to the Pest Filter child rows on
Crop Scouted, so each crop can carry its own per-pest stages and recording
types.

Idempotent: skips Pest Filter rows that already have stages, and leaves the
old Pest.stages rows in place (the Pest.stages field has been removed from
the doctype JSON, so the orphaned rows are harmless).

Note: Frappe's parent.save() doesn't cascade into grandchildren, so the
new Pests Stages rows under each Pest Filter row are inserted directly.
"""

import frappe


def execute():
    if not frappe.db.table_exists("Pest Filter"):
        return

    crops = frappe.get_all("Crop Scouted", pluck="name")
    for crop_name in crops:
        crop = frappe.get_doc("Crop Scouted", crop_name)

        for filter_row in (crop.pests or []):
            already_migrated = frappe.db.exists(
                "Pests Stages",
                {"parent": filter_row.name, "parenttype": "Pest Filter"},
            )
            if already_migrated:
                continue

            pest_stages = frappe.get_all(
                "Pests Stages",
                filters={"parent": filter_row.pest, "parenttype": "Pest"},
                fields=["stage", "image", "symbol", "reading_type", "plant_sections"],
                order_by="idx",
            )
            if not pest_stages:
                continue

            for idx, s in enumerate(pest_stages, start=1):
                ps = frappe.new_doc("Pests Stages")
                ps.parent = filter_row.name
                ps.parenttype = "Pest Filter"
                ps.parentfield = "stages"
                ps.idx = idx
                ps.stage = s.stage or ""
                ps.image = s.image or ""
                ps.symbol = s.symbol or ""
                ps.reading_type = s.reading_type or "Count"
                ps.plant_sections = s.plant_sections or ""
                ps.db_insert()

    frappe.db.commit()
