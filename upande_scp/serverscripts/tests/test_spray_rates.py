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
		self.assertIn("per 1000 Litre of water", r[1]["line"])

	def test_no_rows_is_legacy_default(self):
		d = self._product(lo=5, up=6)
		r = sr.rates_for(d.name, "x")
		self.assertEqual(len(r), 1)
		self.assertEqual(
			{k: r[0][k] for k in ("basis", "lower", "upper", "crop", "source", "per_qty", "per_uom", "per_base")},
			{"basis": "Water", "lower": 5.0, "upper": 6.0, "crop": None, "source": "default",
			 "per_qty": 1000.0, "per_uom": "Litre", "per_base": 1000.0})

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


class TestSprayRateUnits(TestSprayRates):
	"""Units on rate rows. Inherits the helpers (and re-runs the old tests, which must still pass)."""

	def _row(self, d):
		return sr.rates_for(d.name, None)[0]

	def test_migration_same_numbers_same_quantities(self):
		"""Rows with no unit (the pre-change shape) read the legacy way, and after the patch
		carry per 1000 Litre / per 1 Hectare, with identical quantities either way."""
		from upande_scp.patches.v1_0.spray_rates_per_uom import convert_rate_rows

		crop = frappe.get_all("Crop Scouted", limit=1, pluck="name")[0]
		d = self._product([
			{"basis": "Water", "lower_rate_limit": 0.3, "upper_rate_limit": 1},
			{"crop": crop, "basis": "Hectarage", "lower_rate_limit": 2.75, "upper_rate_limit": 4},
		])
		# make them look like pre-migration rows
		frappe.db.sql("UPDATE `tabSpray Product Crop Rate` SET per_qty=0, per_uom=NULL, rate_line=NULL WHERE parent=%s", d.name)
		before = {r["basis"]: r for r in sr.rates_for(d.name, crop)}
		legacy_w = sr.quantity_for(0.3, "Water", water_l=12345.6, per_base=before["Water"]["per_base"])
		legacy_a = sr.quantity_for(2.75, "Hectarage", area_m2=23456.7, per_base=before["Hectarage"]["per_base"])
		self.assertEqual(legacy_w, 0.3 * 12345.6 / 1000)
		self.assertEqual(legacy_a, 2.75 * 23456.7 / 10000)

		self.assertEqual(convert_rate_rows(), 2)
		rows = frappe.get_all("Spray Product Crop Rate", filters={"parent": d.name},
		                      fields=["basis", "per_qty", "per_uom", "rate_line"])
		by = {r.basis: r for r in rows}
		self.assertEqual((by["Water"].per_qty, by["Water"].per_uom), (1000, "Litre"))
		self.assertEqual((by["Hectarage"].per_qty, by["Hectarage"].per_uom), (1, "Hectare"))
		self.assertTrue(by["Water"].rate_line)
		after = {r["basis"]: r for r in sr.rates_for(d.name, crop)}
		self.assertEqual(after["Water"]["per_base"], 1000.0)
		self.assertEqual(after["Hectarage"]["per_base"], 10000.0)
		self.assertEqual(sr.quantity_for(0.3, "Water", water_l=12345.6, per_base=after["Water"]["per_base"]), legacy_w)
		self.assertEqual(sr.quantity_for(2.75, "Hectarage", area_m2=23456.7, per_base=after["Hectarage"]["per_base"]), legacy_a)
		# idempotent
		self.assertEqual(convert_rate_rows(), 0)

	def test_mixed_tank_area_and_water_products(self):
		area = self._product([{"basis": "Hectarage", "lower_rate_limit": 1, "upper_rate_limit": 3,
		                       "per_qty": 1, "per_uom": "Hectare"}])
		qa = sr.quantity_for(2, "Hectarage", area_m2=25000, per_base=self._row(area)["per_base"])
		self.assertAlmostEqual(qa, 5.0)
		qw = sr.quantity_for(0.5, "Water", water_l=1500, per_base=1000)
		self.assertAlmostEqual(qw, 0.75)

	def test_units_acre_100l_and_ml(self):
		acre = self._row(self._product([{"basis": "Hectarage", "lower_rate_limit": 1, "per_qty": 1, "per_uom": "Acre"}]))
		self.assertAlmostEqual(acre["per_base"], 1 / 0.000247, places=4)
		self.assertIn("per Acre of area", acre["line"])
		self.assertAlmostEqual(sr.quantity_for(2, "Hectarage", area_m2=2 * acre["per_base"], per_base=acre["per_base"]), 4.0)
		hund = self._row(self._product([{"basis": "Water", "lower_rate_limit": 0.5, "per_qty": 100, "per_uom": "Litre"}]))
		self.assertEqual(hund["per_base"], 100.0)
		self.assertAlmostEqual(sr.quantity_for(0.5, "Water", water_l=400, per_base=hund["per_base"]), 2.0)
		# ml has a Litre conversion on this site
		ml = self._row(self._product([{"basis": "Water", "lower_rate_limit": 1, "per_qty": 100, "per_uom": "Millilitre"}]))
		self.assertAlmostEqual(ml["per_base"], 0.1)
		self.assertAlmostEqual(sr.quantity_for(1, "Water", water_l=50, per_base=ml["per_base"]), 500.0)

	def test_water_bounds_rescaled_to_per_1000_l(self):
		d = self._product([{"basis": "Water", "lower_rate_limit": 0.05, "upper_rate_limit": 0.1, "per_qty": 100, "per_uom": "Litre"}])
		lo, up = sr.water_bounds(d.name, None)
		self.assertAlmostEqual(lo, 0.5)
		self.assertAlmostEqual(up, 1.0)

	def test_uom_without_conversion_or_wrong_category_refused(self):
		with self.assertRaises(frappe.ValidationError):
			sr.uom_to_base("Kg", "Water")  # a mass unit
		with self.assertRaises(frappe.ValidationError):
			sr.uom_to_base("Litre", "Hectarage")  # volume on an area rate
		frappe.get_doc({"doctype": "UOM", "uom_name": "Zz Test Pail", "category": "Volume"}).insert(ignore_permissions=True)
		with self.assertRaises(frappe.ValidationError):
			sr.uom_to_base("Zz Test Pail", "Water")  # right category, no conversion
		with self.assertRaises(frappe.ValidationError):
			self._product([{"basis": "Water", "lower_rate_limit": 1, "per_qty": 1, "per_uom": "Zz Test Pail"}])

	def test_rate_status_cases(self):
		"""Same cases as spray-rates.test.ts 'rate range, as the server reads it'."""
		cases = [
			("Water", 1000, 0.2, "below"), ("Water", 1000, 0.5, "ok"), ("Water", 100, 20, "above"),
			("Hectarage", 10000, 20, "above"), ("Hectarage", 4048.582995, 4, "ok"),
		]
		for basis, per_base, qty, want in cases:
			row = {"basis": basis, "per_base": per_base, "lower": 0.3, "upper": 1}
			rate = sr.rate_from_quantity(qty, row, area_m2=20000, water_l=1000)
			status = "ok"
			if rate is not None:
				rate = round(rate, 6)
				status = "below" if rate < 0.3 else "above" if rate > 1 else "ok"
			self.assertEqual(status, want, (basis, per_base, qty))
		self.assertIsNone(sr.rate_from_quantity(5, {"basis": "Water", "per_base": 1000}, None, None))

	def test_rate_status_end_to_end(self):
		d = self._product([{"basis": "Hectarage", "lower_rate_limit": 1, "upper_rate_limit": 3, "per_qty": 1, "per_uom": "Hectare"}])
		self.assertEqual(sr.rate_status(d.name, None, 5, area_m2=20000, water_l=0, prefer_area=True), "ok")      # 2.5/ha
		self.assertEqual(sr.rate_status(d.name, None, 8, area_m2=20000, prefer_area=True), "above")             # 4/ha
		self.assertEqual(sr.rate_status(d.name, None, 1, area_m2=20000, prefer_area=True), "below")             # 0.5/ha
		self.assertEqual(sr.rate_status(d.name, None, 1, area_m2=0, prefer_area=True), "ok")                    # no measure

	def test_needs_water(self):
		a = self._product([{"basis": "Hectarage", "lower_rate_limit": 1}])
		self.assertFalse(sr.needs_water([a.name], None, prefer_area=True))
		self.assertFalse(sr.needs_water([a.name], None, prefer_area=False))  # only row is Area
		self.assertTrue(sr.needs_water(["No Such Product"], None, prefer_area=True))

	def test_product_types_seeded_and_validated(self):
		from upande_scp.upande_scp.doctype.spray_product_type.spray_product_type import SEED_TYPES, ensure_product_types

		ensure_product_types()
		for t in SEED_TYPES:
			self.assertTrue(frappe.db.exists("Spray Product Type", t), t)
		self.assertEqual(frappe.get_meta("Spray Product").get_field("type").options, "Spray Product Type")

	def test_rate_uoms_offered_per_basis(self):
		u = sr.rate_uoms()
		self.assertEqual(u["Water"][0], "Litre")
		self.assertEqual(u["Hectarage"][0], "Square Meter")
		for name in ("Millilitre", "Gallon Liquid (US)"):
			self.assertIn(name, u["Water"])
		for name in ("Hectare", "Acre"):
			self.assertIn(name, u["Hectarage"])
		self.assertNotIn("Kg", u["Water"])
		self.assertNotIn("Litre", u["Hectarage"])
