"""Point the SCP apps-screen tile at the animated mark (scp_logo.svg).

The ``Desktop Icon`` row was given ``upande_logo.png`` by the rebrand patches,
which have already run, so the hooks change alone does not reach existing
sites. Only SCP's own logo path is touched. Idempotent.
"""

import frappe

OLD = "/assets/upande_scp/images/upande_logo.png"
NEW = "/assets/upande_scp/images/scp_logo.svg"


def execute():
	if not frappe.db.table_exists("Desktop Icon") or not frappe.db.has_column("Desktop Icon", "logo_url"):
		return
	frappe.db.sql("UPDATE `tabDesktop Icon` SET logo_url = %s WHERE logo_url = %s", (NEW, OLD))
	frappe.clear_cache()
