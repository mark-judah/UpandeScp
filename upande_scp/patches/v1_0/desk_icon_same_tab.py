"""Open SCP from the desk grid in the same tab.

Frappe's desk grid opens an ``External`` Desktop Icon as an absolute URL in a new
tab (desktop.js get_route + setup_click). Pointing the icon at its Workspace
Sidebar instead routes inside the desk, in the same tab, landing on the SCP
workspace (the sidebar's first link). Idempotent.
"""

import frappe


def execute():
	if not frappe.db.table_exists("Desktop Icon") or not frappe.db.exists("Workspace Sidebar", "SCP"):
		return
	for name in frappe.get_all(
		"Desktop Icon", filters={"app": "upande_scp", "link_type": "External"}, pluck="name"
	):
		frappe.db.set_value(
			"Desktop Icon", name, {"link_type": "Workspace Sidebar", "link_to": "SCP", "link": None}
		)
	frappe.clear_cache()
