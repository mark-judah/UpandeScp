import unittest

import frappe

from upande_scp.serverscripts.common import spray_rates as sr


class TestSprayRates(unittest.TestCase):
	"""Plain TestCase: FrappeTestCase bootstraps test records, which fails on this
	site (no "All Departments"). Every write is rolled back after each test, and
	no existing Spray Product is touched — the item used has none."""

	def tearDown(self):
		frappe.db.rollback()

	def _product(self, rows=(), lo=0, up=0):
		item = frappe.db.sql(
			"""SELECT i.name FROM `tabItem` i
			   LEFT JOIN `tabSpray Product` sp ON sp.name = i.name
			   WHERE sp.name IS NULL LIMIT 1"""
		)[0][0]
		d = frappe.get_doc({
			"doctype": "Spray Product", "item": item, "category": "Chemical",
			"default_lower_rate_limit": lo, "default_upper_rate_limit": up,
			"crop_rates": list(rows),
		})
		d.insert(ignore_permissions=True)
		return d

	def test_ordering_and_fallback(self):
		crop = frappe.get_all("Crop Scouted", limit=1, pluck="name")[0]
		d = self._product([
			{"basis": "Water", "lower_rate_limit": 1, "upper_rate_limit": 2},
			{"crop": crop, "basis": "Hectarage", "lower_rate_limit": 3, "upper_rate_limit": 4},
		], lo=5, up=6)
		r = sr.rates_for(d.name, crop)
		self.assertEqual([(x["basis"], x["crop"], x["source"]) for x in r],
			[("Hectarage", crop, "crop"), ("Water", None, "crop"), ("Water", None, "default")])
		self.assertEqual([x["basis"] for x in sr.rates_for(d.name, None)], ["Water", "Water"])
		self.assertEqual(sr.water_bounds(d.name, crop), (1, 2))

	def test_no_rows_is_legacy_default(self):
		d = self._product(lo=5, up=6)
		self.assertEqual(sr.rates_for(d.name, "x"), [
			{"basis": "Water", "lower": 5.0, "upper": 6.0, "crop": None, "source": "default"}])

	def test_quantity(self):
		self.assertEqual(sr.quantity_for(2, "Water", water_l=500), 1.0)
		self.assertEqual(sr.quantity_for(2, "Hectarage", area_m2=5000), 1.0)
		with self.assertRaises(frappe.ValidationError):
			sr.quantity_for(2, "Hectarage", water_l=500)
		with self.assertRaises(frappe.ValidationError):
			sr.quantity_for(2, "Water", area_m2=500)

	def test_duplicate_crop_basis_refused_but_both_bases_ok(self):
		crop = frappe.get_all("Crop Scouted", limit=1, pluck="name")[0]
		row = lambda b: {"crop": crop, "basis": b, "lower_rate_limit": 1, "upper_rate_limit": 2}
		self._product([row("Water"), row("Hectarage")])
		with self.assertRaises(frappe.ValidationError):
			self._product([row("Water"), row("Water")])
