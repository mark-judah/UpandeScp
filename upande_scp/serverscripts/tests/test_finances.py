"""Crop-protection finance report (roadmap item 9, ported from mona).

Three layers:

* the attribution rule and the F2 "count each unit once" matrix, as pure
  functions;
* the report builder over synthetic lines, so every figure is known in advance
  (reconciliation, split marking, cost per target, zero valuation, scoping);
* the endpoint over kaitet.local itself — its total must equal an independent
  ledger query, or the SQL and the F2 filter have drifted apart.
"""

import unittest

import frappe

from upande_scp.serverscripts.reports import finances

FROM_DATE, TO_DATE = "2020-01-01", "2030-12-31"


# ---------------------------------------------------------------------------
# attribution (F3)
# ---------------------------------------------------------------------------
class TestAttribute(unittest.TestCase):
	def test_product_targets_pin_the_cost_down(self):
		buckets, split = finances._attribute("chemical", {"Thrips"}, ["Thrips", "Botrytis"])
		self.assertEqual(buckets, ["Thrips"])
		self.assertFalse(split)

	def test_chemical_without_a_matching_target_is_split_across_the_plan(self):
		buckets, split = finances._attribute("chemical", {"Aphids"}, ["Thrips", "Botrytis"])
		self.assertEqual(buckets, ["Thrips", "Botrytis"])
		self.assertTrue(split)

	def test_foliar_without_a_matching_target_is_nutrition(self):
		buckets, split = finances._attribute("foliar", set(), ["Thrips"])
		self.assertEqual(buckets, [finances.NUTRITION])
		self.assertFalse(split)

	def test_no_plan_targets_is_unattributed_for_every_kind(self):
		self.assertEqual(finances._attribute("chemical", {"Thrips"}, []), ([], False))
		self.assertEqual(finances._attribute("foliar", set(), []), ([], False))


# ---------------------------------------------------------------------------
# F2 — count each unit once, where it leaves the store for use
# ---------------------------------------------------------------------------
def _is_wip(name):
	return "CSU" in (name or "")


class TestCounted(unittest.TestCase):
	def _line(self, entry_type, purpose, s_wh="Chemical Store Chepsito - KR"):
		return {"stock_entry_type": entry_type, "purpose": purpose, "s_warehouse": s_wh}

	def test_transfer_for_manufacture_counts(self):
		line = self._line("CSU Chemical Transfer", "Material Transfer for Manufacture")
		self.assertTrue(finances._counted(line, _is_wip))
		line = self._line("Material Transfer for Manufacture", "Material Transfer for Manufacture")
		self.assertTrue(finances._counted(line, _is_wip))

	def test_material_issue_from_a_store_counts(self):
		self.assertTrue(finances._counted(self._line("Material Issue", "Material Issue"), _is_wip))

	def test_chemical_spray_from_a_store_counts(self):
		line = self._line("Chemical Spray", "Material Issue", "Chepsito GH 17 - KR")
		self.assertTrue(finances._counted(line, _is_wip))

	def test_chemical_spray_from_a_csu_is_already_counted_by_its_transfer(self):
		line = self._line("Chemical Spray", "Material Issue", "Chepsito CSU Phase 1 - KR")
		self.assertFalse(finances._counted(line, _is_wip))

	def test_any_issue_out_of_a_wip_area_is_already_counted(self):
		line = self._line("Material Issue", "Material Issue", "Torongo CSU Phase 3 - KR")
		self.assertFalse(finances._counted(line, _is_wip))

	def test_moves_mixes_and_receipts_never_count(self):
		for entry_type, purpose in (
			("Chemical Loaning", "Material Transfer"),
			("Material Transfer", "Material Transfer"),
			("Chemical Mixing", "Manufacture"),
			("Manufacture", "Manufacture"),
			("Material Receipt", "Material Receipt"),
		):
			with self.subTest(entry_type=entry_type):
				self.assertFalse(finances._counted(self._line(entry_type, purpose), _is_wip))

	def test_a_custom_excluded_type_stays_excluded_whatever_its_purpose(self):
		# Loaning is a farm-to-farm move even if a site maps it to an issue.
		line = self._line("Chemical Loaning", "Material Issue")
		self.assertFalse(finances._counted(line, _is_wip))


# ---------------------------------------------------------------------------
# the builder over known lines (F3, F4, F5)
# ---------------------------------------------------------------------------
def _l(**kw):
	base = {
		"stock_entry": "SE-1",
		"posting_date": "2026-09-01",
		"stock_entry_type": "CSU Chemical Transfer",
		"purpose": "Material Transfer for Manufacture",
		"s_warehouse": "Chemical Store A",
		"item_code": "CHEM-A",
		"item_name": "Chem A",
		"item_group": "CHEMICALS",
		"qty": 1.0,
		"stock_uom": "Litre",
		"amount": 100.0,
		"cost_center": "Main - X",
		"greenhouse": "A GH 01",
		"targets": "Thrips",
		"gh_farm": "FarmA",
		"src_farm": "FarmA",
	}
	base.update(kw)
	return base


PRODUCT_TARGETS = {"CHEM-A": {"Thrips"}, "CHEM-B": set(), "FOL-A": set()}


def _build(lines, **kw):
	return finances._build(
		lines,
		pests={"Thrips", "Aphids"},
		diseases={"Botrytis"},
		product_targets=lambda code: PRODUCT_TARGETS.get(code, set()),
		classify=lambda group: "foliar" if group == "Fertilizer" else "chemical",
		is_wip=_is_wip,
		**kw,
	)


class TestBuild(unittest.TestCase):
	def setUp(self):
		self.lines = [
			# attributed: CHEM-A treats Thrips
			_l(amount=300.0),
			# split: CHEM-B has no targets, plan has Thrips + Botrytis
			_l(item_code="CHEM-B", item_name="Chem B", amount=200.0, targets="Thrips\nBotrytis"),
			# foliar, no matching target -> Nutrition
			_l(item_code="FOL-A", item_name="Fol A", item_group="Fertilizer", amount=50.0),
			# second farm, attributed to Thrips
			_l(greenhouse="B GH 02", gh_farm="FarmB", src_farm="FarmB", amount=150.0),
			# store issue without a work order -> unattributed under its store's farm
			_l(stock_entry_type="Material Issue", purpose="Material Issue", greenhouse=None,
			   targets=None, gh_farm=None, src_farm="FarmA", cost_center="Store CC", amount=80.0),
			# husbandry op in the targets is not a spend target -> unattributed
			_l(targets="Re-bending", amount=20.0),
			# zero valuation -> listed, counts 0
			_l(stock_entry="SE-ZERO", amount=0.0, qty=2.0),
			# excluded: loaning and a spray out of the CSU
			_l(stock_entry_type="Chemical Loaning", purpose="Material Transfer", amount=999.0),
			_l(stock_entry_type="Chemical Spray", purpose="Material Issue",
			   s_warehouse="A CSU Phase 1", amount=777.0),
		]
		self.report = _build(self.lines)

	def test_grand_total_counts_only_the_included_lines(self):
		self.assertAlmostEqual(self.report["grand_total"], 300 + 200 + 50 + 150 + 80 + 20)

	def test_kind_totals_sum_to_the_grand_total(self):
		self.assertAlmostEqual(self.report["totals_by_kind"]["chemical"], 750.0)
		self.assertAlmostEqual(self.report["totals_by_kind"]["foliar"], 50.0)

	def test_cells_reconcile_and_carry_their_provenance(self):
		farm_a = next(f for f in self.report["farms"] if f["farm"] == "FarmA")
		row = next(r for r in farm_a["rows"] if r["kind"] == "chemical")
		thrips = row["costs"]["Thrips"]
		self.assertAlmostEqual(thrips["value"], 400.0)  # 300 + half of 200
		self.assertAlmostEqual(thrips["attributed"], 300.0)
		self.assertAlmostEqual(thrips["split"], 100.0)
		self.assertEqual(thrips["split_items"], ["CHEM-B"])
		self.assertAlmostEqual(row["costs"]["Botrytis"]["split"], 100.0)
		self.assertAlmostEqual(row["total"], 500.0)
		foliar = next(r for r in farm_a["rows"] if r["kind"] == "foliar")
		self.assertAlmostEqual(foliar["costs"][finances.NUTRITION]["value"], 50.0)

	def test_unattributed_spend_keeps_its_farm_and_cost_centre(self):
		got = {(u["farm"], u["cost_center"], u["kind"]): u["value"] for u in self.report["unattributed"]}
		self.assertEqual(got, {("FarmA", "Store CC", "chemical"): 80.0, ("FarmA", "Main - X", "chemical"): 20.0})

	def test_cost_per_target_answers_what_treating_a_pest_cost(self):
		per = {t["target"]: t for t in self.report["cost_per_target"]}
		self.assertEqual(set(per), {"Thrips", "Botrytis"})  # Nutrition is not a pest
		self.assertAlmostEqual(per["Thrips"]["value"], 550.0)
		self.assertAlmostEqual(per["Thrips"]["split"], 100.0)
		self.assertEqual(per["Thrips"]["kind"], "pest")
		self.assertEqual(per["Thrips"]["houses"], 2)
		self.assertEqual(per["Botrytis"]["kind"], "disease")
		self.assertAlmostEqual(per["Thrips"]["share"] + per["Botrytis"]["share"], 1.0)
		self.assertEqual(self.report["cost_per_target"][0]["target"], "Thrips")

	def test_zero_valuation_rows_are_listed_not_hidden(self):
		self.assertEqual(len(self.report["no_valuation"]), 1)
		nv = self.report["no_valuation"][0]
		self.assertEqual(nv["stock_entry"], "SE-ZERO")
		self.assertEqual(nv["qty"], 2.0)
		self.assertEqual(nv["greenhouse"], "A GH 01")

	def test_untargeted_products_are_listed(self):
		codes = {u["item_code"] for u in self.report["untargeted_items"]}
		self.assertEqual(codes, {"CHEM-B", "FOL-A"})
		self.assertEqual(self.report["item_names"]["CHEM-B"], "Chem B")

	def test_farm_scope_drops_other_farms_everywhere(self):
		report = _build(self.lines, farm_scope={"FarmB"})
		self.assertEqual([f["farm"] for f in report["farms"]], ["FarmB"])
		self.assertEqual(report["unattributed"], [])
		self.assertAlmostEqual(report["grand_total"], 150.0)
		self.assertEqual(report["no_valuation"], [])

	def test_an_empty_scope_reports_nothing(self):
		report = _build(self.lines, farm_scope=set())
		self.assertEqual(report["grand_total"], 0.0)
		self.assertEqual(report["farms"], [])


# ---------------------------------------------------------------------------
# the endpoint over kaitet.local
# ---------------------------------------------------------------------------
class TestRealData(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")
		cls.report = finances.chemical_cost_by_target(FROM_DATE, TO_DATE)

	def test_grand_total_matches_an_independent_ledger_query(self):
		from upande_scp.serverscripts.common import crop_protection
		from upande_scp.serverscripts.spray_plan_creator.crop_settings import is_wip_area

		groups = crop_protection.product_groups()
		rows = frappe.db.sql(
			"""
			SELECT se.stock_entry_type, se.purpose, sed.s_warehouse, sed.amount
			FROM `tabStock Entry` se
			JOIN `tabStock Entry Detail` sed ON sed.parent = se.name
			JOIN `tabItem` i ON i.name = sed.item_code
			WHERE se.docstatus = 1 AND i.item_group IN %(g)s
			  AND se.posting_date BETWEEN %(f)s AND %(t)s
			""",
			{"g": groups, "f": FROM_DATE, "t": TO_DATE},
			as_dict=True,
		)
		expected = 0.0
		for r in rows:
			if r.stock_entry_type in ("Chemical Loaning", "Chemical Mixing"):
				continue
			if r.purpose == "Material Transfer for Manufacture":
				expected += float(r.amount or 0)
			elif r.purpose == "Material Issue" and not is_wip_area(r.s_warehouse):
				expected += float(r.amount or 0)
		self.assertAlmostEqual(self.report["grand_total"], expected, delta=1.0)
		self.assertGreater(expected, 0, "fixture check: kaitet.local has crop-protection spend")

	def test_kind_totals_and_cells_reconcile(self):
		self.assertAlmostEqual(
			sum(self.report["totals_by_kind"].values()), self.report["grand_total"], delta=1.0
		)
		for farm in self.report["farms"]:
			for row in farm["rows"]:
				self.assertAlmostEqual(sum(c["value"] for c in row["costs"].values()), row["total"], places=1)
				for cell in row["costs"].values():
					self.assertAlmostEqual(cell["attributed"] + cell["split"], cell["value"], places=1)

	def test_kaitet_has_zero_valuation_lines_and_lists_them(self):
		self.assertTrue(self.report["no_valuation"])

	def test_crop_scope_limits_the_farms(self):
		from upande_scp.serverscripts.common import crop_scope

		report = finances.chemical_cost_by_target(FROM_DATE, TO_DATE, crop="rose")
		rose = crop_scope.farms_for_crop("Rose")
		for farm in report["farms"]:
			self.assertIn(farm["farm"], rose)
		for u in report["unattributed"]:
			self.assertIn(u["farm"], rose)
		self.assertLessEqual(report["grand_total"], self.report["grand_total"] + 0.01)

	def test_refused_without_a_finance_role(self):
		try:
			frappe.set_user("Guest")
			with self.assertRaises(frappe.PermissionError):
				finances.chemical_cost_by_target(FROM_DATE, TO_DATE)
		finally:
			frappe.set_user("Administrator")
