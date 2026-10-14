"""Rename the settings Single: Spray Plan Settings -> Scouting and Crop
Protection Settings.

Ported from kaitet (same patch name) and extended for mona.

pre_model_sync, on purpose: the DB DocType (and its tabSingles values) must be
renamed BEFORE doctype sync loads the new-named JSON. Otherwise sync sees a new
doctype called "Scouting and Crop Protection Settings", creates it empty, and
treats "Spray Plan Settings" as an orphan - the same trap the Chemical -> Spray
Product rename documents. Every value mona already had (allowed farms, store
lists, scan verification, asset-check rows ...) would be orphaned.

Gotchas this handles:
  * ``rename_doc`` repoints ``parenttype`` on child rows but leaves ``parent``
    (which for a Single's child rows is the doctype name) on the old name, so
    ``get_single`` then loads no children. Every child table is repointed - the
    list is discovered (every istable DocType), not hard-coded, because mona has
    tables kaitet does not (Spray Plan Store Warehouse, SCP Asset Check Farm).
  * Idempotent and a no-op when the new name already exists or the old one never
    did (fresh install).
"""

import frappe

OLD = "Spray Plan Settings"
NEW = "Scouting and Crop Protection Settings"


def execute():
	if frappe.db.exists("DocType", NEW):
		return
	if not frappe.db.exists("DocType", OLD):
		return

	frappe.rename_doc("DocType", OLD, NEW, force=True)

	repointed = 0
	for child in frappe.get_all("DocType", filters={"istable": 1}, pluck="name"):
		if not frappe.db.table_exists(child):
			continue
		if not (frappe.db.has_column(child, "parent") and frappe.db.has_column(child, "parenttype")):
			continue
		frappe.db.sql(
			f"UPDATE `tab{child}` SET parent=%s, parenttype=%s WHERE parent=%s OR parenttype=%s",
			(NEW, NEW, OLD, OLD),
		)
		repointed += frappe.db.sql("SELECT ROW_COUNT()")[0][0]

	frappe.clear_cache()
	print(f"[scp-settings-rename] {OLD} -> {NEW}; child rows repointed: {repointed}")
