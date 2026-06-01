"""Move disease stages from the Plant Disease master onto per-crop Disease
Filter rows (parity with pests), then delete the now-unused master rows.

After this, Disease Filter.stages is the live home for disease stages; mobile,
caches, and the thresholds editor all read from there. The Plant Disease
`stages` field has been removed from the doctype JSON, so the master Disease
Stages rows (parenttype='Plant Disease') linger until this patch deletes them.

Idempotent: skips a Disease Filter that already has stages; safe to re-run.
"""

import frappe


def execute():
    if not frappe.db.table_exists("Disease Filter"):
        return

    filled = inserted = 0
    for f in frappe.get_all("Disease Filter", fields=["name", "crop_scouted", "disease"]):
        if not f.disease:
            continue
        if frappe.db.exists("Disease Stages", {"parent": f.name, "parenttype": "Disease Filter"}):
            continue

        master = frappe.get_all(
            "Disease Stages",
            filters={"parent": f.disease, "parenttype": "Plant Disease"},
            fields=[
                "stage", "reading_type", "plant_sections", "range_min", "range_max",
                "low_threshold", "moderate_threshold", "high_threshold",
            ],
            order_by="idx",
        )
        if not master:
            continue

        filled += 1
        for i, s in enumerate(master, start=1):
            ds = frappe.new_doc("Disease Stages")
            ds.parent = f.name
            ds.parenttype = "Disease Filter"
            ds.parentfield = "stages"
            ds.idx = i
            ds.stage = s.stage or ""
            ds.reading_type = s.reading_type or "Count"
            ds.plant_sections = s.plant_sections or ""
            ds.range_min = s.range_min
            ds.range_max = s.range_max
            ds.low_threshold = s.low_threshold or 0
            ds.moderate_threshold = s.moderate_threshold or 0
            ds.high_threshold = s.high_threshold or 0
            ds.db_insert()
            inserted += 1

    master_count = frappe.db.sql(
        "SELECT COUNT(*) FROM `tabDisease Stages` WHERE parenttype = 'Plant Disease'"
    )[0][0]
    frappe.db.delete("Disease Stages", {"parenttype": "Plant Disease"})
    frappe.db.commit()
    print(
        f"  consolidate_disease_stages: filled {filled} Disease Filters "
        f"({inserted} stages), deleted {master_count} master rows"
    )
