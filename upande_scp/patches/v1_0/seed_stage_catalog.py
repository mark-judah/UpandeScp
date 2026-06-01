"""Seed the Stage catalog from existing stage names.

`Pests Stages.stage` and `Disease Stages.stage` became Link fields pointing at
the new standalone `Stage` DocType. The columns already hold the stage names
(e.g. "Eggs", "Adult Moth") as plain text; this patch makes those names valid
links by creating a Stage doc for each distinct name across both child tables
(every parenttype — per-crop filters AND the legacy masters).

`icon_key` is seeded from the stage's life-stage semantics, matching the
frontend marker library vocabulary (circle / triangle / pentagon / diamond /
plus / cross — see frontend MarkerDefs.shapeForStage). Operators can refine it.

Idempotent: skips names that already have a Stage doc.
"""

import frappe

# Stage name (case-insensitive substring) -> bundled marker icon key. Mirrors
# the frontend MarkerDefs.shapeForStage vocabulary so the catalog value is a
# real, renderable icon key. Unknown stages fall back to "circle".
_ICON_RULES = (
    ("adult", "circle"),
    ("larv", "triangle"),
    ("nymph", "pentagon"),
    ("egg", "diamond"),
    ("pupa", "plus"),
    ("instar", "cross"),
)


def icon_key_for(stage_name):
    s = (stage_name or "").lower()
    for needle, key in _ICON_RULES:
        if needle in s:
            return key
    return "circle"


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
        doc = frappe.new_doc("Stage")
        doc.stage_name = name
        doc.icon_key = icon_key_for(name)
        doc.default_reading_type = (
            reading_type if reading_type in ("Count", "Checkbox", "Range") else "Count"
        )
        doc.insert(ignore_permissions=True)
        created += 1

    frappe.db.commit()
    print(f"  seed_stage_catalog: created {created} Stage docs ({len(seen)} distinct names)")
