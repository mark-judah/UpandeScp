"""Promote Pest Filter and Disease Filter from child tables to standalone
DocTypes. Runs PRE model sync: while the `parent` column still exists, copy
each row's parent crop into a new `crop_scouted` column. After this patch,
model sync flips istable→0 and drops `parent`, but the crop link is preserved.

Pests Stages / Disease Stages rows are untouched: they keep
parent=<filter row name>, parenttype='Pest Filter'/'Disease Filter', and the
filter row names do not change, so they stay correctly attached.

Idempotent: skips a table whose crop_scouted column is already populated.
"""

import frappe


def execute():
    for table, doctype in (
        ("tabPest Filter", "Pest Filter"),
        ("tabDisease Filter", "Disease Filter"),
    ):
        if not frappe.db.table_exists(doctype):
            continue

        columns = {c["Field"] for c in frappe.db.sql(f"DESCRIBE `{table}`", as_dict=True)}

        # Already migrated (column exists and standalone sync already ran)?
        if "crop_scouted" in columns and "parent" not in columns:
            continue

        # Add the column while the table is still a child table.
        if "crop_scouted" not in columns:
            frappe.db.sql(
                f"ALTER TABLE `{table}` ADD COLUMN `crop_scouted` VARCHAR(140)"
            )

        # Copy the parent crop into crop_scouted for rows parented to a crop.
        if "parent" in columns:
            frappe.db.sql(
                f"""
                UPDATE `{table}`
                SET crop_scouted = parent
                WHERE parenttype = 'Crop Scouted'
                  AND (crop_scouted IS NULL OR crop_scouted = '')
                """
            )

        moved = frappe.db.sql(
            f"SELECT COUNT(*) FROM `{table}` WHERE crop_scouted IS NOT NULL AND crop_scouted != ''"
        )[0][0]
        print(f"  promote_filters_to_standalone: {doctype}: {moved} rows carry crop_scouted")

    frappe.db.commit()
