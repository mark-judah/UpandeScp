"""Context loader against kaitet.local. DB test — direct runner. Read-only."""

import unittest

import frappe

from upande_scp.serverscripts.spray_compliance import context as C
from upande_scp.serverscripts.spray_compliance.engine import RULES


class TestContext(unittest.TestCase):
	def test_products_read_codes_from_spray_product(self):
		item = frappe.db.sql("""select parent from `tabFRAC Code Filter`
		                        where parenttype='Spray Product' limit 1""")[0][0]
		p = C.load_products([item, "NO-SUCH-ITEM"])
		self.assertIn(item, p)
		self.assertNotIn("NO-SUCH-ITEM", p)
		self.assertTrue(p[item]["frac"])
		for k in ("name", "category", "type", "targets", "irac", "frac", "ingredients"):
			self.assertIn(k, p[item])

	def test_codes_come_live_from_linked_ingredients(self):
		if not frappe.db.exists("Active Ingredient MoA", "Azoxystrobin"):
			frappe.get_doc({"doctype": "Active Ingredient MoA", "ingredient": "Azoxystrobin",
			                "kind": "Fungicide", "frac_code": "11"}).insert(ignore_permissions=True)
		item = frappe.get_all("Spray Product", filters={"disabled": 0, "category": "Chemical"}, pluck="name", limit=1)[0]
		doc = frappe.get_doc("Spray Product", item)
		doc.set("frac", [])
		doc.set("active_ingredients", [{"active_ingredient": "Azoxystrobin", "concentration": 250,
		                                "concentration_unit": "g/L", "ingredient": "Azoxystrobin [250 g/L]"}])
		doc.save(ignore_permissions=True)
		p = C.load_products([item])[item]
		self.assertIn("11", p["frac"])
		self.assertEqual(p["ingredients"], ["Azoxystrobin"])
		frappe.db.rollback()

	def test_crop_for_a_rose_greenhouse(self):
		farms = [r.farm for r in frappe.get_doc("Crop Scouted", "Rose").farms]
		gh = frappe.db.get_value("Warehouse", {"custom_farm": ["in", farms], "is_group": 0}, "name")
		self.assertEqual(C.crop_for_greenhouse(gh), "Rose")
		self.assertEqual(C.crop_for_greenhouse("Nowhere"), "")

	def test_build_context_shape(self):
		c = C.build_context(greenhouse="Nowhere", targets=["Thrips"], mix=["X"])
		self.assertEqual(set(c["modes"]), set(RULES))
		self.assertEqual(c["history"], [])
		for k in ("alternate_moa", "max_sprays", "known_resistance"):
			self.assertIn(k, c["guidelines"])
		self.assertIn("now", c)

	def test_known_resistance_from_guidelines(self):
		c = C.build_context(greenhouse="Nowhere", targets=["Powdery Mildew"], mix=[])
		self.assertIn({"kind": "frac", "target": "Powdery Mildew", "code": "11"},
		              c["guidelines"]["known_resistance"])
