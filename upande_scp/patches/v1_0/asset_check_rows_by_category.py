"""Asset check rows now carry an asset category instead of a template.

Reads the leftover ``check_sheet_template`` column (Frappe keeps a removed field's
column) and derives each row's category from that template. Rows whose template no
longer exists are dropped. Safe to re-run.
"""
import frappe


def execute() -> None:
	if not frappe.db.has_column("SCP Asset Check Farm", "check_sheet_template"):
		return
	if not frappe.db.table_exists("Asset Check Sheet Template"):
		return
	rows = frappe.db.sql(
		"select name, check_sheet_template from `tabSCP Asset Check Farm` "
		"where ifnull(asset_category, '') = ''",
		as_dict=True,
	)
	for r in rows:
		cat = frappe.db.get_value("Asset Check Sheet Template", r.check_sheet_template, "asset_category")
		if cat:
			frappe.db.set_value("SCP Asset Check Farm", r.name, "asset_category", cat, update_modified=False)
		else:
			frappe.db.delete("SCP Asset Check Farm", {"name": r.name})
