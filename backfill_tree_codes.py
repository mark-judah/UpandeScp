"""
Migrate tree data from the legacy "trees are Zones" representation to the new
Tree doctype.

For each Zone whose linked Bed has unit_type=Row:
  1. Create (or reuse) a Tree record with the same tree_number (Zone.zone).
  2. Copy the canonical `tree_code` from `build_tree_code`.
  3. Re-point any Scouting Entry rows whose `tree` field still holds the old
     Zone name onto the new Tree name.
  4. Leave the Zone record itself untouched (non-tree zones keep their naming,
     and historical Scouting Entries that still reference a Zone by name stay
     intact — only the `tree` Link is migrated).

USAGE  (bench console)
----------------------
exec(open('/home/ubuntu/stive/code/frappe15/apps/upande_scp/backfill_tree_codes.py').read())
"""

import frappe

from upande_scp.upande_scp.doctype.tree.tree import build_tree_code


def migrate():
	row_beds = frappe.get_all(
		"Bed", filters={"unit_type": "Row"}, pluck="name"
	)
	if not row_beds:
		print("No Row-type beds found; nothing to migrate.")
		return

	legacy_tree_zones = frappe.get_all(
		"Zone",
		filters={"bed": ["in", row_beds]},
		fields=["name", "bed", "zone"],
	)
	print(
		f"Found {len(legacy_tree_zones)} legacy tree-zones under {len(row_beds)} rows."
	)

	created = 0
	repointed = 0
	for legacy in legacy_tree_zones:
		row_name = legacy.bed
		tree_number = legacy.zone or "1"
		code = build_tree_code(row_name, tree_number)

		existing = frappe.db.exists("Tree", code)
		if not existing:
			tree_doc = frappe.new_doc("Tree")
			tree_doc.row = row_name
			tree_doc.tree_number = tree_number
			tree_doc.tree_code = code
			tree_doc.block = frappe.db.get_value("Bed", row_name, "greenhouse")
			# is_model defaults to 0; flip per-tree via the UI or a seed script.
			tree_doc.insert(ignore_permissions=True)
			created += 1
			print(f"  Created Tree {code} (from Zone {legacy.name})")

		# Re-point Scouting Entry.tree from legacy Zone name → new Tree name
		affected = frappe.get_all(
			"Scouting Entry",
			filters={"tree": legacy.name},
			pluck="name",
		)
		for se in affected:
			frappe.db.set_value(
				"Scouting Entry", se, "tree", code, update_modified=False
			)
			repointed += 1

	frappe.db.commit()
	print(
		f"Done. Created {created} Tree records and re-pointed "
		f"{repointed} Scouting Entry.tree links."
	)


migrate()
