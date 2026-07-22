"""Drop the chemical custom fields from Item.

Chemical metadata now lives on the Chemical / Foliar sidecar doctypes (every
chemical/fertilizer item has one), and all readers resolve through
crop_protection.get_product_*. Deleting these Custom Fields drops their Item
columns. The per-variety `custom_chemical_intervention_threshhold` and the
`custom_scouting_and_crop_protection_tab` are intentionally KEPT (variety data).

Idempotent. Non-destructive to the sidecars — only the redundant Item columns go.
"""

import frappe

FIELDS = [
	"custom_section_break_vuei1",
	"custom_type",
	"custom_active_ingredients",
	"custom_toxicity",
	"custom_reentry_interval_hrs",
	"custom_targets",
	"custom_irac",
	"custom_irac_moa",
	"custom_frac",
	"custom_frac_moa",
	"custom_ghs",
	"custom_ghs_description",
	"custom_lower_rate_limit",
	"custom_upper_rate_limit",
	"custom_low_stock_threshold",
]


def execute():
	for fieldname in FIELDS:
		name = f"Item-{fieldname}"
		if frappe.db.exists("Custom Field", name):
			frappe.delete_doc("Custom Field", name, ignore_permissions=True, force=True)
	frappe.clear_cache(doctype="Item")
