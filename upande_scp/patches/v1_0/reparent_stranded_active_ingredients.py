"""Re-parent Active Ingredient rows left behind on Item by the Chemical/Foliar
migration.

`introduce_chemical_foliar_doctypes` copied each Item's `custom_active_ingredients`
into the new sidecar, but rows written against the Item *after* (or outside) that
run stayed with `parenttype='Item'`. They are invisible to
`crop_protection.get_product_codes` and to anything reading the sidecar, so the
active ingredient reads as "unknown" even though it was recorded.

On kaitet this recovers 44 of 45 stranded rows (the 45th points at an Item with
no Chemical/Foliar sidecar, so there is nowhere to move it — left in place rather
than deleted, since it is the only remaining copy of that datum).

Idempotent: rows already present on the sidecar are skipped, not duplicated.
"""

import frappe

_PARENTS = (("Chemical", "chemical"), ("Foliar", "foliar"))


def execute():
	if not frappe.db.table_exists("Active Ingredient"):
		return

	stranded = frappe.get_all(
		"Active Ingredient",
		filters={"parenttype": "Item"},
		fields=["name", "parent", "parentfield", "ingredient"],
	)
	if not stranded:
		return

	moved = orphaned = skipped = 0
	for row in stranded:
		if not row.ingredient:
			continue

		target_dt = target_name = None
		for doctype, _field in _PARENTS:
			found = frappe.db.get_value(doctype, {"item": row.parent}, "name")
			if found:
				target_dt, target_name = doctype, found
				break

		if not target_name:
			# No sidecar for this Item — leave the row alone. It is the only
			# surviving copy, and deleting it would lose the ingredient.
			orphaned += 1
			continue

		already = frappe.db.exists(
			"Active Ingredient",
			{
				"parent": target_name,
				"parenttype": target_dt,
				"ingredient": row.ingredient,
			},
		)
		if already:
			skipped += 1
			continue

		frappe.db.set_value(
			"Active Ingredient",
			row.name,
			{
				"parent": target_name,
				"parenttype": target_dt,
				"parentfield": "active_ingredients",
			},
			update_modified=False,
		)
		moved += 1

	frappe.db.commit()
	frappe.clear_cache()
	print(
		f"reparent_stranded_active_ingredients: moved={moved} "
		f"already_present={skipped} no_sidecar={orphaned}"
	)
