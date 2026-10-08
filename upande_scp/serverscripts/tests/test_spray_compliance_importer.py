"""Roses importer. Pure parts run anywhere; the DB parts use the direct runner and roll back."""

import unittest

import frappe

from upande_scp.serverscripts.spray_compliance import importer as M


class TestPure(unittest.TestCase):
	def test_split_targets(self):
		self.assertEqual(M.split_targets("Thrips, Aphids and Whiteflies"), ["Thrips", "Aphids", "Whiteflies"])
		self.assertEqual(M.split_targets("Botrytis & Powdery Mildew"), ["Botrytis", "Powdery Mildew"])
		self.assertEqual(M.split_targets("Thrips, Mealybugs, Spidermites"), ["Thrips", "Mealybugs", "Spidermites"])

	def test_map_target(self):
		self.assertEqual(M.map_target("Caterpillars (Helicoverpa)"), ("Helicoverpa", "mapped"))
		self.assertEqual(M.map_target("Bollworms"), ("Helicoverpa", "mapped"))
		self.assertEqual(M.map_target("Caterpillars (Spodoptera)"), ("Spodoptera", "mapped"))
		self.assertEqual(M.map_target("Spidermites"), ("Spidermites", "mapped"))
		self.assertEqual(M.map_target("Adjuvant"), (None, "non_target"))
		self.assertEqual(M.map_target("Plant Growth Regulator"), (None, "non_target"))
		self.assertEqual(M.map_target("Soil borne fungal diseases"), (None, "unmapped"))

	def test_normalise_trade_name(self):
		self.assertEqual(M.normalise_trade_name("AMITIV 250 SC"), M.normalise_trade_name("Amitiv 250sc"))
		self.assertEqual(M.normalise_trade_name("PREVICUR ENERGY SL 840"), M.normalise_trade_name("PREVICUR ENERGY SL840"))
		self.assertNotEqual(M.normalise_trade_name("MELODY COMPACT WG 49"), M.normalise_trade_name("MELODY DUO (WG 69)"))
		self.assertEqual(M.normalise_trade_name("CRYPTOGRAN SC\xa0"), "CRYPTOGRAN")


SHEET = "/home/ubuntu/stive/code/frappe15/apps/upande_scp/doc references/CHemicals/Crop Protection Agents + Target Pest.xlsx"


class TestDryRun(unittest.TestCase):
	def setUp(self):
		from upande_scp.serverscripts.spray_compliance import moa_seed
		moa_seed.seed(dry_run=False, commit=False)

	def tearDown(self):
		frappe.db.rollback()

	def test_dry_run_reports_and_writes_nothing(self):
		before = frappe.db.count("Chemical Targets", {"parenttype": "Spray Product"})
		r = M.import_roses_sheet(SHEET, apply=False)
		self.assertEqual(frappe.db.count("Chemical Targets", {"parenttype": "Spray Product"}), before)
		self.assertEqual(len(r["rows"]), 49)  # the sheet skips S.No. 28 and 44
		by = {x["trade_name"]: x for x in r["rows"]}
		self.assertIn("1111101036", by["DISARM 480 SC"]["matched"])
		self.assertEqual(by["DISARM 480 SC"]["type_fix"], "Fungicide")
		self.assertEqual(by["DELEGATE 250 WG"]["irac"], ["5"])
		self.assertEqual(by["AMITIV 250 SC"]["frac"], ["11"])
		self.assertTrue(by["AMISIL"]["non_target"])
		self.assertEqual(by["RIZOLEX 50 WP"]["unmapped_targets"], ["Soil borne fungal diseases"])
		self.assertEqual(r["summary"]["unknown_ingredients"], [])
		col = {e["ingredient"]: e for e in by["COLLIS 30 SC"]["entries"]}
		self.assertEqual((col["Boscalid"]["concentration"], col["Boscalid"]["unit"]), (200.0, "g/L"))
		self.assertEqual(sorted(r["summary"]["no_concentration"]), ["BEAUVITECH WP", "GRACIA 10 EC", "THURICIDE"])

	def test_apply_is_fill_blanks_and_idempotent(self):
		M.import_roses_sheet(SHEET, apply=True, commit=False)
		n1 = frappe.db.count("Chemical Targets", {"parenttype": "Spray Product"})
		a1 = frappe.db.count("Active Ingredient", {"parenttype": "Spray Product"})
		M.import_roses_sheet(SHEET, apply=True, commit=False)
		self.assertEqual(frappe.db.count("Chemical Targets", {"parenttype": "Spray Product"}), n1)
		self.assertEqual(frappe.db.count("Active Ingredient", {"parenttype": "Spray Product"}), a1)
		row = frappe.db.get_value("Active Ingredient", {"parenttype": "Spray Product", "parent": "1110001",
		                          "active_ingredient": "Boscalid"}, ["concentration", "concentration_unit"])
		self.assertEqual(row, (200.0, "g/L"))

	@staticmethod
	def _child_counts():
		meta = frappe.get_meta("Spray Product")
		return {f.options: frappe.db.count(f.options, {"parenttype": "Spray Product"})
		        for f in meta.get_table_fields()} | {"_products": frappe.db.count("Spray Product")}

	def test_apply_never_overwrites_and_gates_ambiguous_matches(self):
		# a pre-set registration number, type and concentration must survive
		frappe.db.set_value("Spray Product", "1111101036", {"registration_no": "KEEP-ME", "type": "Adjuvant"})
		ai = frappe.db.get_value("Active Ingredient", {"parenttype": "Spray Product", "parent": "1111101036"}, "name")
		frappe.db.set_value("Active Ingredient", ai, "concentration", 123)
		first_word = {"GOLAN SUPER 200SL", "EVISECT S", "BEAUVITECH WP", "LECATECH WP"}
		pre = self._child_counts()
		r = M.import_roses_sheet(SHEET, apply=True, commit=False)
		skipped = {x["trade_name"] for x in r["summary"]["skipped_unconfirmed"]}
		self.assertTrue(first_word <= skipped)
		self.assertIn("MELTATOX 400 EC", skipped)
		self.assertEqual(frappe.db.get_value("Spray Product", "1111101036", "type"), "Adjuvant")
		self.assertEqual(frappe.db.get_value("Active Ingredient", ai, "concentration"), 123)
		self.assertEqual(frappe.db.get_value("Spray Product", "1111101036", "registration_no"), "KEEP-ME")
		self.assertEqual(self._child_counts()["_products"], pre["_products"])
		self.assertEqual(frappe.db.count("FRAC Code Filter", {"parenttype": "Spray Product"}), pre.get("FRAC Code Filter", 0))
		self.assertEqual(frappe.db.count("IRAC Code Filter", {"parenttype": "Spray Product"}), pre.get("IRAC Code Filter", 0))
		# skipped rows wrote nothing: compare with an accepting run
		mid = self._child_counts()
		M.import_roses_sheet(SHEET, apply=True, commit=False)
		self.assertEqual(self._child_counts(), mid)  # idempotent across ALL child tables
		M.import_roses_sheet(SHEET, apply=True, commit=False, accept=list(first_word | {"MELTATOX 400 EC", "LECATECH WP"}))
		after = self._child_counts()
		self.assertGreater(sum(after.values()), sum(mid.values()))
		self.assertEqual(frappe.db.get_value("Spray Product", "1111101036", "registration_no"), "KEEP-ME")
		M.import_roses_sheet(SHEET, apply=True, commit=False, accept=list(first_word | {"MELTATOX 400 EC", "LECATECH WP"}))
		self.assertEqual(self._child_counts(), after)

	def test_apply_aborts_without_moa(self):
		frappe.db.delete("Active Ingredient MoA")
		with self.assertRaises(frappe.ValidationError):
			M.import_roses_sheet(SHEET, apply=True, commit=False)

	def test_migrate_existing_links_typos_and_reads_leading_concentration(self):
		r = M.migrate_existing_ingredients(apply=False)
		texts = {m["text"]: m for m in r["matched"]}
		self.assertEqual(texts["emmamectin benzoate"]["active_ingredient"], "Emamectin benzoate")
		self.assertEqual(texts["50g/l Difenoconazole"]["concentration"], 50.0)
		self.assertIn("garlic extract", {u["text"] for u in r["unmatched"]})
