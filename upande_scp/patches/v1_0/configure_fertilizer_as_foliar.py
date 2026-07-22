"""Configure the `Fertilizer` Item Group as a foliar group and backfill Foliar
records (copying each item's legacy custom_* values).

This gives the fertilizer items a home in the Foliar doctype so chemical
metadata is no longer read from Item for them either. Idempotent.
"""

import frappe

from upande_scp.serverscripts.common.crop_protection import ensure_product_record

SETTINGS = "Scouting and Crop Protection Settings"
GROUP = "Fertilizer"


def execute():
	if not frappe.db.exists("Item Group", GROUP):
		return

	settings = frappe.get_single(SETTINGS)
	existing = {r.item_group for r in (settings.foliar_item_groups or [])}
	if GROUP not in existing:
		settings.append("foliar_item_groups", {"item_group": GROUP})
		settings.save(ignore_permissions=True)
	frappe.clear_cache()  # so the helper's cached settings pick up the new group

	created = 0
	for code in frappe.get_all("Item", filters={"item_group": GROUP}, pluck="name"):
		if ensure_product_record(code):
			created += 1

	frappe.db.commit()
	print(f"[configure_fertilizer_as_foliar] foliars_created={created}")
