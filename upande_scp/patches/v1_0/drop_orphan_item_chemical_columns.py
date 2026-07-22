"""Drop the now-orphaned Item chemical columns.

Deleting the Custom Fields removes them from the form/meta but Frappe leaves the
underlying DB columns. These scalar columns are now unused (data lives on the
Chemical/Foliar sidecars); drop them. Table/Table-MultiSelect fields have no
Item column, so only scalars are listed. Idempotent.
"""

import frappe

COLUMNS = [
	"custom_type",
	"custom_toxicity",
	"custom_lower_rate_limit",
	"custom_upper_rate_limit",
	"custom_low_stock_threshold",
	"custom_reentry_interval_hrs",
	"custom_irac_moa",
	"custom_frac_moa",
	"custom_ghs_description",
]


def execute():
	for col in COLUMNS:
		if frappe.db.has_column("Item", col):
			frappe.db.sql_ddl(f"ALTER TABLE `tabItem` DROP COLUMN `{col}`")
	frappe.clear_cache(doctype="Item")
