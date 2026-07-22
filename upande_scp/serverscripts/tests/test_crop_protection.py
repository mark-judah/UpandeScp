"""End-to-end tests for the Chemical / Foliar crop-protection model.

Exercises the full flow against a throwaway crop-protection group config:
  - auto-creation of the Chemical/Foliar sidecar when an item is inserted in a
    configured group (the Item after_insert hook),
  - config-driven classification (is_chemical / is_foliar / classify),
  - rate/type/code resolution (sidecar default -> per-crop profile override),
  - the settings editor writing metadata to the sidecar (not the Item) and the
    editor list surfacing it (config-driven group filter),
  - confirmation that the chemical custom fields are gone from Item,
  - the group-overlap guard on the settings doctype.

Uses plain unittest (the app's convention for this non-pristine site) and
cleans up its own fixtures in tearDownClass, so nothing leaks into the site.
Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_crop_protection
"""

import unittest

import frappe

from upande_scp.serverscripts.common import crop_protection as cp

SETTINGS = "Scouting and Crop Protection Settings"
CHEM_GROUP = "_TEST CP Chemicals"
FOL_GROUP = "_TEST CP Foliars"
CROP = "_TEST CP Crop"
_ITEM_PREFIX = "_TEST-CP-"


def _ensure_item_group(name):
	if not frappe.db.exists("Item Group", name):
		frappe.get_doc({
			"doctype": "Item Group",
			"item_group_name": name,
			"parent_item_group": "All Item Groups",
			"is_group": 0,
		}).insert(ignore_permissions=True, ignore_if_duplicate=True)


def _delete_sidecars_for(code):
	for master, link in (("Chemical", "chemical"), ("Foliar", "foliar")):
		name = frappe.db.get_value(master, {"item": code}, "name")
		if not name:
			continue
		for prof in frappe.get_all(f"{master} Crop Profile", filters={link: name}, pluck="name"):
			frappe.delete_doc(f"{master} Crop Profile", prof, force=True, ignore_permissions=True)
		frappe.delete_doc(master, name, force=True, ignore_permissions=True)


def _make_item(code, group):
	"""Create a fresh test item (and let the hook create its sidecar),
	clearing any leftover sidecar/item from an earlier run first."""
	_delete_sidecars_for(code)
	if frappe.db.exists("Item", code):
		frappe.delete_doc("Item", code, force=True, ignore_permissions=True)
	return frappe.get_doc({
		"doctype": "Item",
		"item_code": code,
		"item_name": code,
		"item_group": group,
		"stock_uom": "Nos",
		"is_stock_item": 0,
	}).insert(ignore_permissions=True)


class TestCropProtection(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")
		_ensure_item_group(CHEM_GROUP)
		_ensure_item_group(FOL_GROUP)
		if not frappe.db.exists("Crop Scouted", CROP):
			frappe.get_doc({"doctype": "Crop Scouted", "crop_name": CROP}).insert(
				ignore_permissions=True, ignore_if_duplicate=True,
			)
		settings = frappe.get_single(SETTINGS)
		chem = {r.item_group for r in (settings.chemical_item_groups or [])}
		fol = {r.item_group for r in (settings.foliar_item_groups or [])}
		if CHEM_GROUP not in chem:
			settings.append("chemical_item_groups", {"item_group": CHEM_GROUP})
		if FOL_GROUP not in fol:
			settings.append("foliar_item_groups", {"item_group": FOL_GROUP})
		settings.save(ignore_permissions=True)
		frappe.db.commit()
		frappe.clear_cache()

	@classmethod
	def tearDownClass(cls):
		for master, link in (("Chemical", "chemical"), ("Foliar", "foliar")):
			for prof in frappe.get_all(f"{master} Crop Profile", filters={"crop": CROP}, pluck="name"):
				frappe.delete_doc(f"{master} Crop Profile", prof, force=True, ignore_permissions=True)
			for name in frappe.get_all(master, filters={"item": ["like", f"{_ITEM_PREFIX}%"]}, pluck="name"):
				frappe.delete_doc(master, name, force=True, ignore_permissions=True)
		for name in frappe.get_all("Item", filters={"item_code": ["like", f"{_ITEM_PREFIX}%"]}, pluck="name"):
			frappe.delete_doc("Item", name, force=True, ignore_permissions=True)
		settings = frappe.get_single(SETTINGS)
		settings.chemical_item_groups = [
			r for r in (settings.chemical_item_groups or []) if r.item_group != CHEM_GROUP
		]
		settings.foliar_item_groups = [
			r for r in (settings.foliar_item_groups or []) if r.item_group != FOL_GROUP
		]
		settings.save(ignore_permissions=True)
		for doctype, name in (("Crop Scouted", CROP), ("Item Group", CHEM_GROUP), ("Item Group", FOL_GROUP)):
			if frappe.db.exists(doctype, name):
				frappe.delete_doc(doctype, name, force=True, ignore_permissions=True)
		frappe.db.commit()
		frappe.clear_cache()

	# -- classification -------------------------------------------------
	def test_classify_item_group(self):
		self.assertEqual(cp.classify_item_group(CHEM_GROUP), "chemical")
		self.assertEqual(cp.classify_item_group(FOL_GROUP), "foliar")
		self.assertIsNone(cp.classify_item_group("All Item Groups"))

	# -- auto-create hook ----------------------------------------------
	def test_item_insert_autocreates_chemical(self):
		item = _make_item(f"{_ITEM_PREFIX}CHEM-1", CHEM_GROUP)
		self.assertTrue(cp.is_chemical(item.name))
		self.assertFalse(cp.is_foliar(item.name))
		self.assertTrue(frappe.db.exists("Chemical", item.name))  # 1:1, named after item

	def test_item_insert_autocreates_foliar(self):
		item = _make_item(f"{_ITEM_PREFIX}FOL-1", FOL_GROUP)
		self.assertTrue(cp.is_foliar(item.name))
		self.assertFalse(cp.is_chemical(item.name))

	# -- rate resolution: default then per-crop override ----------------
	def test_rate_default_then_profile_override(self):
		item = _make_item(f"{_ITEM_PREFIX}CHEM-2", CHEM_GROUP)
		chem = frappe.get_doc("Chemical", item.name)
		chem.default_lower_rate_limit = 1.0
		chem.default_upper_rate_limit = 2.0
		chem.save(ignore_permissions=True)
		self.assertEqual(cp.get_product_rate(item.name), (1.0, 2.0))

		frappe.get_doc({
			"doctype": "Chemical Crop Profile",
			"chemical": chem.name,
			"crop": CROP,
			"lower_rate_limit": 5.0,
			"upper_rate_limit": 6.0,
		}).insert(ignore_permissions=True)
		self.assertEqual(cp.get_product_rate(item.name, CROP), (5.0, 6.0))  # profile wins
		self.assertEqual(cp.get_product_rate(item.name), (1.0, 2.0))        # default without crop

	def test_type_resolves_from_sidecar(self):
		item = _make_item(f"{_ITEM_PREFIX}CHEM-4", CHEM_GROUP)
		chem = frappe.get_doc("Chemical", item.name)
		chem.type = "Fungicide"
		chem.save(ignore_permissions=True)
		self.assertEqual(cp.get_product_type(item.name), "Fungicide")
		self.assertEqual(cp.get_product_codes(item.name, "frac"), [])

	# -- settings editor writes to the sidecar and lists it -------------
	def test_editor_save_writes_to_sidecar(self):
		from upande_scp.serverscripts.spray_plan_creator import settings as s

		item = _make_item(f"{_ITEM_PREFIX}CHEM-3", CHEM_GROUP)
		s.save_chemical(item.name, {"upper_rate_limit": 9.0, "type": "Insecticide"})
		row = frappe.db.get_value(
			"Chemical", item.name, ["default_upper_rate_limit", "type"], as_dict=True,
		)
		self.assertEqual(row.default_upper_rate_limit, 9.0)
		self.assertEqual(row.type, "Insecticide")

		listed = s.list_chemicals(query=item.name, page=1, page_size=50, kind="chemical")
		match = [r for r in listed["items"] if r["item_code"] == item.name]
		self.assertTrue(match, "item should appear in the config-driven chemical list")
		self.assertEqual(match[0]["custom_upper_rate_limit"], 9.0)

	# -- Item no longer carries chemical metadata ----------------------
	def test_item_has_no_chemical_columns(self):
		meta = frappe.get_meta("Item")
		for fieldname in (
			"custom_type", "custom_toxicity", "custom_lower_rate_limit",
			"custom_upper_rate_limit", "custom_low_stock_threshold",
			"custom_reentry_interval_hrs", "custom_targets",
			"custom_active_ingredients", "custom_irac", "custom_frac", "custom_ghs",
		):
			self.assertIsNone(
				meta.get_field(fieldname),
				f"{fieldname} should have been removed from Item",
			)
		# The per-variety field is intentionally kept.
		self.assertIsNotNone(meta.get_field("custom_chemical_intervention_threshhold"))

	# -- group-overlap guard -------------------------------------------
	def test_group_cannot_be_both_chemical_and_foliar(self):
		settings = frappe.get_single(SETTINGS)
		settings.append("foliar_item_groups", {"item_group": CHEM_GROUP})
		with self.assertRaises(frappe.ValidationError):
			settings.save(ignore_permissions=True)
