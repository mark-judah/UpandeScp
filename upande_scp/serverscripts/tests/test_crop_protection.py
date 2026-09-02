"""End-to-end tests for the Spray Product crop-protection model.

Exercises the full flow against a throwaway crop-protection group config:
  - auto-creation of the Spray Product sidecar when an item is inserted in a
    configured group (the Item after_insert hook),
  - config-driven classification (category / is_chemical / is_foliar),
  - rate/type/code resolution (product default -> per-crop `crop_rates` row),
  - following an Item in and out of the configured groups (the on_update hook),
  - the settings editor writing metadata to the sidecar (not the Item) and the
    editor list surfacing it (config-driven group filter),
  - confirmation that the chemical custom fields are gone from Item,
  - the group-overlap guard on the settings doctype.

Was two doctypes with a per-crop override doctype each; `category` and
`crop_rates` replace both splits.

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
	name = frappe.db.get_value(cp.PRODUCT, {"item": code}, "name")
	if name:
		frappe.delete_doc(cp.PRODUCT, name, force=True, ignore_permissions=True)


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
		for name in frappe.get_all(
			cp.PRODUCT, filters={"item": ["like", f"{_ITEM_PREFIX}%"]}, pluck="name"
		):
			frappe.delete_doc(cp.PRODUCT, name, force=True, ignore_permissions=True)
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
		# 1:1 with the Item, and named after it.
		self.assertTrue(frappe.db.exists(cp.PRODUCT, item.name))
		self.assertEqual(
			frappe.db.get_value(cp.PRODUCT, item.name, "category"), cp.CHEMICAL
		)

	def test_item_insert_autocreates_foliar(self):
		item = _make_item(f"{_ITEM_PREFIX}FOL-1", FOL_GROUP)
		self.assertTrue(cp.is_foliar(item.name))
		self.assertFalse(cp.is_chemical(item.name))
		self.assertEqual(
			frappe.db.get_value(cp.PRODUCT, item.name, "category"), cp.FOLIAR
		)

	def test_one_doctype_holds_both_categories(self):
		"""The point of the consolidation: a reader no longer has to try two
		masters in turn to find out what an item is."""
		chem = _make_item(f"{_ITEM_PREFIX}CHEM-BOTH", CHEM_GROUP)
		fol = _make_item(f"{_ITEM_PREFIX}FOL-BOTH", FOL_GROUP)
		for code in (chem.name, fol.name):
			self.assertTrue(cp.is_spray_product(code))
			self.assertTrue(frappe.db.exists(cp.PRODUCT, code))

	# -- rate resolution: default then per-crop override ----------------
	def test_rate_default_then_crop_row_override(self):
		item = _make_item(f"{_ITEM_PREFIX}CHEM-2", CHEM_GROUP)
		prod = frappe.get_doc(cp.PRODUCT, item.name)
		prod.default_lower_rate_limit = 1.0
		prod.default_upper_rate_limit = 2.0
		prod.save(ignore_permissions=True)
		self.assertEqual(cp.get_product_rate(item.name), (1.0, 2.0))

		prod.append("crop_rates", {
			"crop": CROP, "lower_rate_limit": 5.0, "upper_rate_limit": 6.0,
		})
		prod.save(ignore_permissions=True)
		self.assertEqual(cp.get_product_rate(item.name, CROP), (5.0, 6.0))  # crop row wins
		self.assertEqual(cp.get_product_rate(item.name), (1.0, 2.0))        # default without crop

	def test_a_crop_without_a_row_falls_back_to_the_default(self):
		item = _make_item(f"{_ITEM_PREFIX}CHEM-FALLBACK", CHEM_GROUP)
		prod = frappe.get_doc(cp.PRODUCT, item.name)
		prod.default_lower_rate_limit = 3.0
		prod.default_upper_rate_limit = 4.0
		prod.append("crop_rates", {
			"crop": CROP, "lower_rate_limit": 9.0, "upper_rate_limit": 10.0,
		})
		prod.save(ignore_permissions=True)
		self.assertEqual(cp.get_product_rate(item.name, "_TEST CP Other Crop"), (3.0, 4.0))

	def test_duplicate_crop_rows_are_rejected(self):
		"""Two rows for one crop make the effective rate depend on row order."""
		item = _make_item(f"{_ITEM_PREFIX}CHEM-DUP", CHEM_GROUP)
		prod = frappe.get_doc(cp.PRODUCT, item.name)
		prod.append("crop_rates", {"crop": CROP, "lower_rate_limit": 1.0})
		prod.append("crop_rates", {"crop": CROP, "lower_rate_limit": 2.0})
		with self.assertRaises(frappe.ValidationError):
			prod.save(ignore_permissions=True)

	def test_an_inverted_rate_pair_is_rejected(self):
		"""Lower above upper rejects every dose, and only at spray-planning time."""
		item = _make_item(f"{_ITEM_PREFIX}CHEM-INV", CHEM_GROUP)
		prod = frappe.get_doc(cp.PRODUCT, item.name)
		prod.append("crop_rates", {
			"crop": CROP, "lower_rate_limit": 9.0, "upper_rate_limit": 2.0,
		})
		with self.assertRaises(frappe.ValidationError):
			prod.save(ignore_permissions=True)

	def test_type_resolves_from_sidecar(self):
		item = _make_item(f"{_ITEM_PREFIX}CHEM-4", CHEM_GROUP)
		prod = frappe.get_doc(cp.PRODUCT, item.name)
		prod.type = "Fungicide"
		prod.save(ignore_permissions=True)
		self.assertEqual(cp.get_product_type(item.name), "Fungicide")
		self.assertEqual(cp.get_product_codes(item.name, "frac"), [])

	# -- following the Item's group in and out ---------------------------
	def test_leaving_the_configured_groups_disables_the_product(self):
		"""The reported gap: adding an item registered it, removing it left a
		live record in every picker. Disabled, not deleted — BOMs, past spray
		plans and issued QR labels still reference it by item code."""
		item = _make_item(f"{_ITEM_PREFIX}CHEM-EXIT", CHEM_GROUP)
		self.assertTrue(cp.is_spray_product(item.name))

		item.item_group = "All Item Groups"
		item.save(ignore_permissions=True)

		self.assertTrue(
			frappe.db.get_value(cp.PRODUCT, item.name, "disabled"),
			"product should be disabled when its item leaves the groups",
		)
		# Still resolvable by item code, so nothing referencing it breaks.
		self.assertTrue(frappe.db.exists(cp.PRODUCT, item.name))
		self.assertNotIn(item.name, cp.crop_protection_item_codes("chemical"))

	def test_the_rates_survive_being_disabled(self):
		"""Deleting would lose the metadata the moment somebody re-groups the
		Item by mistake."""
		item = _make_item(f"{_ITEM_PREFIX}CHEM-KEEP", CHEM_GROUP)
		prod = frappe.get_doc(cp.PRODUCT, item.name)
		prod.default_lower_rate_limit = 7.0
		prod.save(ignore_permissions=True)

		item.item_group = "All Item Groups"
		item.save(ignore_permissions=True)

		# Unset Floats come back as 0.0, which callers already read as "no bound".
		self.assertEqual(cp.get_product_rate(item.name)[0], 7.0)

	def test_coming_back_re_enables_it(self):
		item = _make_item(f"{_ITEM_PREFIX}CHEM-RETURN", CHEM_GROUP)
		item.item_group = "All Item Groups"
		item.save(ignore_permissions=True)
		self.assertTrue(frappe.db.get_value(cp.PRODUCT, item.name, "disabled"))

		item.item_group = CHEM_GROUP
		item.save(ignore_permissions=True)
		self.assertFalse(frappe.db.get_value(cp.PRODUCT, item.name, "disabled"))

	def test_moving_between_groups_changes_the_category(self):
		"""Category decides which store the product is issued from, so a chemical
		that becomes a foliar has to follow."""
		item = _make_item(f"{_ITEM_PREFIX}CHEM-SWAP", CHEM_GROUP)
		self.assertEqual(frappe.db.get_value(cp.PRODUCT, item.name, "category"), cp.CHEMICAL)

		item.item_group = FOL_GROUP
		item.save(ignore_permissions=True)

		self.assertEqual(frappe.db.get_value(cp.PRODUCT, item.name, "category"), cp.FOLIAR)
		self.assertTrue(cp.is_foliar(item.name))
		self.assertFalse(cp.is_chemical(item.name))

	def test_entering_a_configured_group_later_registers_it(self):
		"""Only `after_insert` was hooked, so an item created outside the groups
		and moved in later never got a record at all."""
		code = f"{_ITEM_PREFIX}LATE"
		item = _make_item(code, "All Item Groups")
		self.assertFalse(cp.is_spray_product(code))

		item.item_group = CHEM_GROUP
		item.save(ignore_permissions=True)

		self.assertTrue(cp.is_spray_product(code))

	def test_saving_an_item_without_touching_its_group_is_a_no_op(self):
		"""Items are saved constantly for unrelated reasons."""
		item = _make_item(f"{_ITEM_PREFIX}CHEM-NOOP", CHEM_GROUP)
		self.assertIsNone(cp.sync_product_to_item_group(item.name))

	# -- settings editor writes to the sidecar and lists it -------------
	def test_editor_save_writes_to_sidecar(self):
		from upande_scp.serverscripts.spray_plan_creator import settings as s

		item = _make_item(f"{_ITEM_PREFIX}CHEM-3", CHEM_GROUP)
		s.save_chemical(item.name, {"upper_rate_limit": 9.0, "type": "Insecticide"})
		row = frappe.db.get_value(
			cp.PRODUCT, item.name, ["default_upper_rate_limit", "type"], as_dict=True,
		)
		self.assertEqual(row.default_upper_rate_limit, 9.0)
		self.assertEqual(row.type, "Insecticide")

		listed = s.list_chemicals(query=item.name, page=1, page_size=50, kind="chemical")
		match = [r for r in listed["items"] if r["item_code"] == item.name]
		self.assertTrue(match, "item should appear in the config-driven chemical list")
		self.assertEqual(match[0]["custom_upper_rate_limit"], 9.0)

	# -- the Application Plan honours the configured groups -------------
	def test_application_plan_lists_configured_groups(self):
		"""The plan's Add-chemical search and its BOM chemical list must resolve
		the group set from config. Hardcoding "CHEMICALS"/"Fertilizer" made a
		chemical added under any other configured group (kaitet: "Weeding
		Solutions") invisible to the plan even though the settings Chemicals
		tab listed it."""
		from upande_scp.serverscripts.scouting import scouting_metrics_api as sma
		from upande_scp.serverscripts.store import create_bom as cb

		chem = _make_item(f"{_ITEM_PREFIX}CHEM-5", CHEM_GROUP)
		fol = _make_item(f"{_ITEM_PREFIX}FOL-2", FOL_GROUP)

		rows = {r["item_code"]: r for r in sma.list_chemical_items(q=_ITEM_PREFIX)}
		self.assertIn(chem.name, rows, "chemical missing from the Add-chemical search")
		self.assertIn(fol.name, rows, "foliar missing from the Add-chemical search")
		self.assertFalse(rows[chem.name]["is_fertilizer"])
		self.assertTrue(rows[fol.name]["is_fertilizer"])

		payload = cb.getAllChemicals()
		self.assertIn(chem.item_name, payload["chemicals"])
		self.assertIn(fol.item_name, payload["fertilizers"])
		self.assertEqual(payload["item_type_map"][fol.item_name], "fertilizer")

	def test_add_chemical_search_matches_item_code(self):
		"""The Add-chemical search takes a code as well as a name — operators who
		work from item codes got an empty list before, which reads as the item
		not existing. The item-group restriction must still hold."""
		from upande_scp.serverscripts.scouting import scouting_metrics_api as sma

		item = _make_item(f"{_ITEM_PREFIX}CHEM-6", CHEM_GROUP)
		frappe.db.set_value("Item", item.name, "item_name", "Zzz Unsearchable Label")

		by_code = [r["item_code"] for r in sma.list_chemical_items(q=item.name)]
		self.assertIn(item.name, by_code, "searching by item code should find the item")

		by_name = [r["item_code"] for r in sma.list_chemical_items(q="Zzz Unsearchable")]
		self.assertIn(item.name, by_name, "searching by item name should still work")

		# A code that matches an Item OUTSIDE the configured groups must not leak
		# through the OR clause.
		outside = frappe.db.get_value(
			"Item", {"item_group": ("not in", list(cp.product_groups()))}, "name"
		)
		if outside:
			leaked = [r["item_code"] for r in sma.list_chemical_items(q=outside)]
			self.assertNotIn(outside, leaked, "group filter must still bound the search")

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
