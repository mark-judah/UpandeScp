"""Rename the settings Single: Spray Plan Settings -> Scouting and Crop
Protection Settings.

Runs pre-model-sync so the DB DocType (and its tabSingles data) is renamed
before doctype sync loads the new-named JSON — otherwise sync would create a
fresh empty doctype and orphan the existing settings. Also defensively repoints
the Single's child-table rows to the new name so farm scoping / keywords /
group config survive.
"""

import frappe

OLD = "Spray Plan Settings"
NEW = "Scouting and Crop Protection Settings"
_CHILD_TABLES = [
	"Spray Plan Allowed Farm",
	"Spray Plan Exclude Keyword",
	"Crop Protection Item Group",
]


def execute():
	if frappe.db.exists("DocType", NEW):
		return
	if not frappe.db.exists("DocType", OLD):
		return

	frappe.rename_doc("DocType", OLD, NEW, force=True)

	# Defensive: ensure the Single's child rows carry the new parent/parenttype.
	# (rename_doc updates parenttype but leaves the `parent` column pointing at
	# the old name, which breaks child-table loading via get_single.)
	for child in _CHILD_TABLES:
		if frappe.db.table_exists(child):
			frappe.db.sql(
				f"UPDATE `tab{child}` SET parent=%s, parenttype=%s "
				"WHERE parent=%s OR parenttype=%s",
				(NEW, NEW, OLD, OLD),
			)

	frappe.clear_cache()
