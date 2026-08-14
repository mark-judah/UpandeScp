"""Drop the two leftover Item fields nothing reads.

Survivors of the Chemical/Foliar migration (`drop_item_chemical_custom_fields`
took the other 15). Both are dead:

* `custom_application_rate` — the application rate lives on the plan's BOM Item
  (`custom_application_rate` / `custom_application_rateper_ha_`) and on the
  Chemical sidecar's rate limits. The Item copy had 1 populated row on kaitet
  and zero readers in this app.
* `custom_greenhouse` — a Link to Warehouse on the *Item* master, which no code
  path reads. 30 populated rows on kaitet, all stale.

Neither was shipped by any app (no fixture, not code-declared), so on a fresh
site they never existed in the first place — this only cleans up the sites that
inherited them from the old upande_kaitet era.

Deleting the Custom Field does not drop the DB column, so both steps are here.
Idempotent.
"""

import frappe

FIELDS = [
	"custom_application_rate",
	"custom_greenhouse",
]


def execute():
	for fieldname in FIELDS:
		name = f"Item-{fieldname}"
		if frappe.db.exists("Custom Field", name):
			frappe.delete_doc("Custom Field", name, ignore_permissions=True, force=True)
		if frappe.db.has_column("Item", fieldname):
			frappe.db.sql_ddl(f"ALTER TABLE `tabItem` DROP COLUMN `{fieldname}`")
	frappe.clear_cache(doctype="Item")
