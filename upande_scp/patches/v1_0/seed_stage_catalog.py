"""Seed the Stage catalog from existing stage names.

`Pests Stages.stage` and `Disease Stages.stage` became Link fields pointing at
the new standalone `Stage` DocType. The columns already hold the stage names
(e.g. "Eggs", "Adult Moth") as plain text; this patch makes those names valid
links by creating a Stage doc for each distinct name across both child tables
(every parenttype — per-crop filters AND the legacy masters).

`icon_key` is seeded with a slugified default (e.g. "Adult Moth" -> "adult-moth")
as a starting point; operators refine it and point it at a real bundled icon.

Idempotent: skips names that already have a Stage doc.
"""

import re

import frappe


def execute():
    if not frappe.db.table_exists("Stage"):
        return

    rows = frappe.db.sql(
        """
        SELECT stage, reading_type FROM `tabPests Stages`
        UNION
        SELECT stage, reading_type FROM `tabDisease Stages`
        """,
        as_dict=True,
    )

    # First non-empty reading_type seen wins as the stage's default.
    seen = {}
    for r in rows:
        name = (r.get("stage") or "").strip()
        if not name:
            continue
        seen.setdefault(name, r.get("reading_type") or "Count")

    created = 0
    for name, reading_type in seen.items():
        if frappe.db.exists("Stage", name):
            continue
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        doc = frappe.new_doc("Stage")
        doc.stage_name = name
        doc.icon_key = slug
        doc.default_reading_type = (
            reading_type if reading_type in ("Count", "Checkbox", "Range") else "Count"
        )
        doc.insert(ignore_permissions=True)
        created += 1

    frappe.db.commit()
    print(f"  seed_stage_catalog: created {created} Stage docs ({len(seen)} distinct names)")
