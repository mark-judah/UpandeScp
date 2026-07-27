"""Remove upande_kaitet's leftover Stock Entry custom fields.

`custom_greenhouse`, `custom_location` and `custom_original_stock_entry` belong
to the legacy upande_kaitet harvest flow, not to upande_scp. That app is no
longer installed, so nothing writes them and no SCP reader depends on them —
the one exception was `auto_material_issue.build_material_issue`, which merely
copied `custom_location` from the manufacture entry onto the material issue;
that passthrough is removed in the same change.

Keeping them was actively harmful to the layout: `custom_greenhouse` competed
with `custom_output_quantity` for the `tab_connections` anchor (two Custom
Fields sharing one insert_after fork Frappe's field-order resolution), and the
three of them sat between the connections tab and the SCP label fields, which
is why the label audit trail had no clean tab of its own.

The label fields (`custom_labels_printed{,_by,_on}`, `custom_labels_print_count`)
are KEPT — they are SCP's, written by
`spray_plan_ops.spray_plan_labels._stamp_labels_printed` and read back by
`spray_plan_creator.lifecycle` and `store.store_keeper_api`. After this patch
`common.scouting_tab_layout` re-anchors them under the Scouting and Crop
Protection tab on its after_migrate pass.

Deleting the Custom Field removes the field from meta but leaves the DB column,
so both steps are done here. Row counts for any populated column are logged
before the drop so the deletion is traceable on sites that still hold data.

Idempotent.
"""

import frappe

FIELDS = [
	"custom_greenhouse",
	"custom_location",
	"custom_original_stock_entry",
]


def execute():
	for fieldname in FIELDS:
		name = f"Stock Entry-{fieldname}"
		if frappe.db.exists("Custom Field", name):
			frappe.delete_doc(
				"Custom Field", name, ignore_permissions=True, force=True
			)

		if not frappe.db.has_column("Stock Entry", fieldname):
			continue

		# Leave a trail before dropping. A populated column here means the site
		# still carried legacy harvest data in a field no installed app reads.
		populated = frappe.db.sql(
			f"""SELECT COUNT(*) FROM `tabStock Entry`
			    WHERE `{fieldname}` IS NOT NULL AND `{fieldname}` != ''"""
		)[0][0]
		if populated:
			frappe.log_error(
				title="remove_kaitet_stock_entry_fields",
				message=(
					f"Dropping Stock Entry.{fieldname} with {populated} "
					"populated row(s) — legacy upande_kaitet field, no "
					"installed app reads it."
				),
			)

		frappe.db.sql_ddl(
			f"ALTER TABLE `tabStock Entry` DROP COLUMN `{fieldname}`"
		)

	frappe.clear_cache(doctype="Stock Entry")
