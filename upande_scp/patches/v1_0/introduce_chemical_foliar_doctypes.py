"""Seed crop-protection config and migrate chemical Item custom fields to the
Chemical doctype.

Idempotent. Seeds the settings `chemical_item_groups` with the chemical Item
Groups that exist, then creates a `Chemical` (if absent) per Item in those
groups, copying the legacy `custom_*` chemical fields into the Chemical master
defaults. No crop profiles are created (defaults preserve current behaviour).
Foliars have no legacy data — created going forward via hook / Export button.
"""

import frappe

SETTINGS = "Scouting and Crop Protection Settings"
CANDIDATE_CHEMICAL_GROUPS = ["CHEMICALS", "AVOCADO CHEMICALS", "Chemical", "Chemicals"]

_STD = {
	"name", "parent", "parenttype", "parentfield", "idx", "doctype",
	"owner", "creation", "modified", "modified_by", "docstatus",
}


def _rows(item_doc, field):
	out = []
	for row in (item_doc.get(field) or []):
		d = row.as_dict()
		out.append({k: v for k, v in d.items() if k not in _STD and not str(k).startswith("_")})
	return out


def execute():
	# 1) Seed chemical item groups (those that exist as Item Group records).
	settings = frappe.get_single(SETTINGS)
	seen = {r.item_group for r in (settings.chemical_item_groups or [])}
	changed = False
	for group in CANDIDATE_CHEMICAL_GROUPS:
		# Resolve to the real Item Group name so case-insensitive DB collation
		# can't create duplicate rows (e.g. "Chemicals" -> "CHEMICALS").
		real = frappe.db.get_value("Item Group", group, "name")
		if real and real not in seen:
			settings.append("chemical_item_groups", {"item_group": real})
			seen.add(real)
			changed = True
	if changed:
		settings.save(ignore_permissions=True)

	groups = [r.item_group for r in (frappe.get_single(SETTINGS).chemical_item_groups or [])]
	if not groups:
		return

	# 2) Create a Chemical per chemical Item, copying legacy custom_* fields.
	created = 0
	for code in frappe.get_all("Item", filters={"item_group": ["in", groups]}, pluck="name"):
		if frappe.db.exists("Chemical", {"item": code}):
			continue
		item = frappe.get_doc("Item", code)
		chem = frappe.new_doc("Chemical")
		chem.item = code
		chem.type = item.get("custom_type")
		chem.toxicity = item.get("custom_toxicity")
		chem.reentry_interval_hrs = item.get("custom_reentry_interval_hrs")
		chem.default_lower_rate_limit = item.get("custom_lower_rate_limit")
		chem.default_upper_rate_limit = item.get("custom_upper_rate_limit")
		chem.low_stock_threshold = item.get("custom_low_stock_threshold")
		chem.irac_moa = item.get("custom_irac_moa")
		chem.frac_moa = item.get("custom_frac_moa")
		chem.ghs_description = item.get("custom_ghs_description")
		for tgt_field, src_field in (
			("active_ingredients", "custom_active_ingredients"),
			("default_targets", "custom_targets"),
			("default_requirements", "custom_chemical_intervention_threshhold"),
			("irac", "custom_irac"),
			("frac", "custom_frac"),
			("ghs", "custom_ghs"),
		):
			for row in _rows(item, src_field):
				chem.append(tgt_field, row)
		chem.insert(ignore_permissions=True)
		created += 1

	frappe.db.commit()
	print(f"[introduce_chemical_foliar_doctypes] groups={groups} chemicals_created={created}")
