import frappe
from frappe.tests.utils import FrappeTestCase

from upande_scp.serverscripts.spray_plan_creator import logsheet_chemistry as lc
from upande_scp.serverscripts.spray_plan_creator.chemical_setup import product_gaps


def _prod(ais, **kw):
	return {"active_ingredients": [
		{"ingredient": n, "concentration": c, "concentration_unit": u} for n, c, u in ais
	], **kw}


class TestChemistryForProduct(FrappeTestCase):
	def test_multi_ai_g_per_l(self):
		v = lc.chemistry_for_product(
			_prod([("Thiosultap-monosodium", 400, "g/L"), ("Buprofezin", 100, "g/L")],
			      toxicity="II", fairtrade_hml="Yellow"), 0.5, "Litre")
		self.assertEqual(v["active_ingredients"], "Thiosultap-monosodium 400 g/L + Buprofezin 100 g/L")
		self.assertEqual(v["toxicity_class"], "II")
		self.assertEqual(v["flo_hml"], "Yellow")
		self.assertAlmostEqual(v["percent_ai"], 50.0)  # 500 g/L / 10
		self.assertAlmostEqual(v["total_ai"], 250.0)  # 0.5 L x 500 g/L

	def test_g_per_kg_and_percent(self):
		v = lc.chemistry_for_product(_prod([("X", 800, "g/kg")]), 2, "Kg")
		self.assertAlmostEqual(v["percent_ai"], 80.0)
		self.assertAlmostEqual(v["total_ai"], 1600.0)
		p = lc.chemistry_for_product(_prod([("Y", 5, "%")]), 1, "Litre")
		self.assertAlmostEqual(p["percent_ai"], 5.0)
		self.assertAlmostEqual(p["total_ai"], 50.0)  # 1% = 10 g/L

	def test_ml_stock_uom_scales(self):
		v = lc.chemistry_for_product(_prod([("X", 100, "g/L")]), 500, "ml")
		self.assertAlmostEqual(v["total_ai"], 50.0)

	def test_biological_counts_left_out_of_mass(self):
		v = lc.chemistry_for_product(_prod([("Bt", 1e9, "CFU/g")]), 1, "Kg")
		self.assertIn("Bt", v["active_ingredients"])
		self.assertNotIn("percent_ai", v)
		self.assertNotIn("total_ai", v)

	def test_missing_master_data(self):
		self.assertEqual(lc.chemistry_for_product(None, 1, "Litre"), {})
		v = lc.chemistry_for_product(_prod([("X", 0, None)]), 1, "Litre")
		self.assertEqual(v, {"active_ingredients": "X"})
		# unknown stock UOM: percent yes, total no
		w = lc.chemistry_for_product(_prod([("X", 100, "g/L")]), 1, "Bottle")
		self.assertIn("percent_ai", w)
		self.assertNotIn("total_ai", w)


class TestFillBlanksOnly(FrappeTestCase):
	def test_typed_values_survive(self):
		sal = frappe._dict(work_order=None, pesticides=[])

		class Row(frappe._dict):
			def set(self, k, v):
				self[k] = v

		row = Row(pesticide_name="nope", pesticide_quantity=1, toxicity_class="IV", active_ingredients=None)
		sal.pesticides = [row]
		sal.get = lambda k, d=None: sal.__getitem__(k) if k in sal else d
		orig = lc._row_values
		lc._row_values = lambda *a, **k: {"toxicity_class": "II", "active_ingredients": "A 1 g/L"}
		try:
			n = lc.fill_pesticide_rows(sal)
		finally:
			lc._row_values = orig
		self.assertEqual(n, 1)
		self.assertEqual(row.toxicity_class, "IV")
		self.assertEqual(row.active_ingredients, "A 1 g/L")

	def test_never_raises(self):
		self.assertEqual(lc.fill_pesticide_rows(object()), 0)

	def test_backfill_dry_run_writes_nothing(self):
		before = frappe.db.sql("select count(*) from `tabSpray Application Pesticide` where ifnull(toxicity_class,'')=''")
		res = lc.backfill_logsheet_chemistry(dry_run=1)
		after = frappe.db.sql("select count(*) from `tabSpray Application Pesticide` where ifnull(toxicity_class,'')=''")
		self.assertTrue(res["dry_run"])
		self.assertEqual(before, after)
		self.assertEqual(set(res["cells_filled"]), set(lc.FIELDS))


class TestGaps(FrappeTestCase):
	def test_gap_detection(self):
		none = lambda n: None
		self.assertEqual(
			product_gaps({"type": "Fungicide", "active_ingredients": []}, none),
			["active_ingredients", "toxicity", "fairtrade_hml", "phi_days", "moa_code"])
		full = {"type": "Insecticide", "toxicity": "II", "fairtrade_hml": "Red", "phi_days": 3,
		        "active_ingredients": [{"ingredient": "a", "concentration": 10, "concentration_unit": "g/L"}]}
		self.assertEqual(product_gaps(full, lambda n: {"irac_code": "4A"}), [])
		self.assertEqual(product_gaps(full, none), ["moa_code"])
		full["active_ingredients"][0]["concentration"] = 0
		self.assertIn("concentration", product_gaps(full, lambda n: {"irac_code": "4A"}))
