"""Seed the station warehouse types with the pair the code used to hardcode.

Before this setting existed, the mobile bundle treated every non-group warehouse
of a farm as a place a scout could be sent — which is how a stock-only warehouse
with no beds reached a picker. The rule is now configuration; this fills it in
with what the rest of the app already assumed, so the change is invisible on an
existing site and editable on a new one.

Idempotent: it adds only what is missing, and never removes a type someone chose.
"""

import frappe

from upande_scp.serverscripts.common.farm_map import DEFAULT_STATION_TYPES


def execute():
	if not frappe.db.table_exists("SCP Station Warehouse Type"):
		return
	settings = frappe.get_single("Scouting and Crop Protection Settings")
	if not settings.meta.has_field("station_warehouse_types"):
		return

	existing = {
		(row.warehouse_type or "").strip()
		for row in (settings.station_warehouse_types or [])
	}
	added = False
	for wt in DEFAULT_STATION_TYPES:
		if wt in existing:
			continue
		# Only offer a type this site actually has, so the grid never links to a
		# Warehouse Type record that does not exist.
		if not frappe.db.exists("Warehouse Type", wt):
			continue
		settings.append("station_warehouse_types", {"warehouse_type": wt})
		added = True

	if added:
		settings.flags.ignore_permissions = True
		settings.save(ignore_permissions=True)
		frappe.db.commit()
