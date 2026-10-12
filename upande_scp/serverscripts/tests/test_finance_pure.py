"""Finance on cost centres and budgets — the decisions, without a site (B2-B8).

Run: cd upande_scp && ../../env/bin/python -m pytest -q \
        upande_scp/serverscripts/tests/test_finance_pure.py
"""

import unittest

from upande_scp.serverscripts.finance import accounts as A
from upande_scp.serverscripts.finance import budgets as B
from upande_scp.serverscripts.finance import cost_centre_mapping as M
from upande_scp.serverscripts.reports import finance_budget as F


class TestRateOrder(unittest.TestCase):
	"""B2: last purchase for the company, else valuation, else 0 with a warning."""

	def test_the_company_purchase_wins(self):
		r = A.pick_rate([
			("last purchase (company)", 120.0),
			("last purchase rate (item)", 99.0),
			("valuation (company)", 80.0),
		])
		self.assertEqual((r["rate"], r["source"], r["warning"]), (120.0, "last purchase (company)", None))

	def test_valuation_when_nothing_was_bought(self):
		r = A.pick_rate([
			("last purchase (company)", 0),
			("last purchase rate (item)", None),
			("valuation (company)", 80.5),
			("valuation rate (item)", 70.0),
		])
		self.assertEqual((r["rate"], r["source"]), (80.5, "valuation (company)"))

	def test_a_negative_rate_is_not_a_rate(self):
		r = A.pick_rate([("last purchase (company)", -5), ("valuation (company)", 3)])
		self.assertEqual(r["rate"], 3)

	def test_nothing_at_all_is_zero_and_said_so(self):
		r = A.pick_rate([("last purchase (company)", 0), ("valuation (company)", None)])
		self.assertEqual(r["rate"], 0.0)
		self.assertIsNone(r["source"])
		self.assertIn("costed at 0", r["warning"])


class TestAccountOrder(unittest.TestCase):
	"""B6: Item Default -> Item Group -> settings row -> single -> company default."""

	CANDIDATES = [
		("item default", None),
		("item group CHEMICALS", None),
		("item group All Item Groups", None),
		("settings (chemical)", "Chem - KR"),
		("settings (single)", "Old - KR"),
		("company default", "COGS - KR"),
	]

	def test_the_first_present_wins(self):
		self.assertEqual(A.first_present(self.CANDIDATES), ("Chem - KR", "settings (chemical)"))

	def test_the_item_beats_its_group(self):
		c = [("item default", "Item - KR"), ("item group X", "Group - KR")] + self.CANDIDATES[3:]
		self.assertEqual(A.first_present(c)[1], "item default")

	def test_a_nearer_group_beats_its_parent(self):
		c = [("item default", ""), ("item group Adjuvants", "Adj - KR"), ("item group All", "All - KR")]
		self.assertEqual(A.first_present(c), ("Adj - KR", "item group Adjuvants"))

	def test_the_company_default_is_the_last_resort(self):
		c = [(s, None) for s, _ in self.CANDIDATES[:-1]] + [self.CANDIDATES[-1]]
		self.assertEqual(A.first_present(c), ("COGS - KR", "company default"))

	def test_nothing_is_none(self):
		self.assertEqual(A.first_present([("a", None), ("b", "")]), (None, None))


class TestFoldRemainder(unittest.TestCase):
	def test_the_remainder_goes_to_the_largest_share(self):
		out = B.fold_remainder(
			[{"farm": "A", "allocated": 33.3, "requested": 100},
			 {"farm": "B", "allocated": 33.3, "requested": 100},
			 {"farm": "C", "allocated": 33.3, "requested": 100}],
			0.1,
		)
		# all equal: the name breaks the tie, so the answer never changes
		self.assertAlmostEqual(out["A"], 33.4)
		self.assertAlmostEqual(sum(out.values()), 100.0)

	def test_rows_add_up_to_what_was_approved(self):
		out = B.fold_remainder(
			[{"farm": "A", "allocated": 59.0, "requested": 59}, {"farm": "B", "allocated": 50.0, "requested": 50}],
			1.0,
		)
		self.assertEqual(out, {"A": 60.0, "B": 50.0})

	def test_a_farm_that_got_nothing_has_no_row(self):
		out = B.fold_remainder([{"farm": "A", "allocated": 10, "requested": 10},
		                        {"farm": "B", "allocated": 0, "requested": 1}], 0)
		self.assertEqual(out, {"A": 10})


class TestGroupBudgetRows(unittest.TestCase):
	LINES = [
		{"cycle": "C1", "farm": "Chepsito", "farm_group": "Chepsito Farm - KR", "account": "Chem - KR",
		 "item_code": "X", "value": 100.0},
		{"cycle": "C2", "farm": "Chepsito", "farm_group": "Chepsito Farm - KR", "account": "Chem - KR",
		 "item_code": "Y", "value": 50.0},
		{"cycle": "C1", "farm": "Chepsito", "farm_group": "Chepsito Farm - KR", "account": "Fert - KR",
		 "item_code": "F", "value": 20.0},
		{"cycle": "C1", "farm": "Kapkolia", "farm_group": "Kapkolia Farm - KR", "account": "Chem - KR",
		 "item_code": "X", "value": 70.0},
		{"cycle": "C1", "farm": "Torongo", "farm_group": None, "account": "Chem - KR",
		 "item_code": "X", "value": 9.0},
		{"cycle": "C1", "farm": "Karen", "farm_group": "Karen  Farm - KR", "account": None,
		 "item_code": "Z", "value": 5.0},
		{"cycle": "C1", "farm": "Karen", "farm_group": "Karen  Farm - KR", "account": "Chem - KR",
		 "item_code": "Q", "value": 0.0},
	]

	def setUp(self):
		self.rows, self.skipped = B.group_budget_rows(self.LINES)

	def test_one_row_per_farm_group_and_account(self):
		keys = [(r["cost_center"], r["account"]) for r in self.rows]
		self.assertEqual(keys, [
			("Chepsito Farm - KR", "Chem - KR"),
			("Chepsito Farm - KR", "Fert - KR"),
			("Kapkolia Farm - KR", "Chem - KR"),
		])

	def test_cycles_in_one_year_add_up_on_one_budget(self):
		chem = self.rows[0]
		self.assertEqual(chem["amount"], 150.0)
		self.assertEqual(chem["cycles"], ["C1", "C2"])
		self.assertEqual(chem["items"], ["X", "Y"])

	def test_chemicals_and_foliars_are_budgeted_apart(self):
		self.assertEqual(self.rows[1]["amount"], 20.0)

	def test_what_cannot_be_budgeted_is_skipped_with_the_reason(self):
		why = {s["farm"]: s["why"] for s in self.skipped}
		self.assertIn("cost-centre group", why["Torongo"])
		self.assertIn("expense account", why["Karen"])
		self.assertEqual(len(self.skipped), 2, "a zero-value line is not a skip")


class TestOverBudget(unittest.TestCase):
	def test_over_warns(self):
		self.assertTrue(B.over_budget(1001, 1000))

	def test_equal_is_not_over(self):
		self.assertFalse(B.over_budget(1000, 1000))

	def test_no_budget_is_no_warning(self):
		self.assertFalse(B.over_budget(5000, None))
		self.assertFalse(B.over_budget(5000, 0))


class TestReconcilingLine(unittest.TestCase):
	def test_stock_moved_but_not_sprayed_is_the_difference(self):
		self.assertEqual(F.reconcile(1200.0, 1000.0), 200.0)

	def test_negative_when_the_ledger_carries_more(self):
		self.assertEqual(F.reconcile(800.0, 1000.0), -200.0)

	def test_no_cost_centre_no_reconciliation(self):
		self.assertIsNone(F.reconcile(800.0, None))

	def test_the_farm_row_reconciles_per_kind_and_in_total(self):
		row = F.shape_farm("Chepsito", "Karen Roses", "Chepsito Farm - KR", {
			"chemical": {"actual": 1000, "stock_based": 1300, "budget": 5000, "approved": 900},
			"foliar": {"actual": 400, "stock_based": 350},
		})
		self.assertEqual(row["kinds"]["chemical"]["reconciling"], 300.0)
		self.assertEqual(row["kinds"]["foliar"]["reconciling"], -50.0)
		self.assertEqual(row["reconciling"], 250.0)
		self.assertEqual(row["actual"], 1400.0)
		self.assertEqual(row["stock_based"] - row["actual"], row["reconciling"])

	def test_an_unmapped_farm_reads_no_ledger(self):
		row = F.shape_farm("Torongo", "Karen Roses", None, {"chemical": {"stock_based": 10}})
		self.assertFalse(row["mapped"])
		self.assertIsNone(row["actual"])
		self.assertIsNone(row["reconciling"])
		self.assertEqual(row["stock_based"], 10.0)


class TestMappingProposals(unittest.TestCase):
	GROUPS = [
		{"name": "Karen Roses - KR", "parent_cost_center": None, "lft": 1, "rgt": 100},
		{"name": "Simotwo  Farm - KR", "parent_cost_center": "Karen Roses - KR", "lft": 2, "rgt": 20},
		{"name": "PH - Post Harvest - KR", "parent_cost_center": "Karen Roses - KR", "lft": 21, "rgt": 30},
		{"name": "Endebess Coffee - KL", "parent_cost_center": "Karen Roses - KR", "lft": 31, "rgt": 60},
		{"name": "BLOCK D - KL", "parent_cost_center": "Endebess Coffee - KL", "lft": 32, "rgt": 40},
		{"name": "BLOCK A - KL", "parent_cost_center": "Endebess Coffee - KL", "lft": 41, "rgt": 45},
	]

	def test_a_double_spaced_farm_group_still_matches_by_name(self):
		self.assertEqual(M.propose_farm_group("Simotwo", "KR", self.GROUPS, []), ("Simotwo  Farm - KR", "name"))

	def test_a_top_level_group_named_after_the_farm(self):
		self.assertEqual(
			M.propose_farm_group("Endebess", "KL", self.GROUPS, [])[0], "Endebess Coffee - KL"
		)

	def test_otherwise_the_widest_group_holding_most_houses(self):
		leaves = [{"lft": 33, "rgt": 33}, {"lft": 34, "rgt": 34}, {"lft": 42, "rgt": 42}]
		groups = [g for g in self.GROUPS if g["name"] != "Endebess Coffee - KL"] + [
			{"name": "Estate X - KL", "parent_cost_center": "Karen Roses - KR", "lft": 31, "rgt": 60},
		]
		got, how = M.propose_farm_group("Saboti", "KL", groups, leaves)
		self.assertEqual(got, "Estate X - KL", "not BLOCK D, which holds only some of them")
		self.assertIn("3 of 3", how)

	def test_never_the_company_root(self):
		leaves = [{"lft": 3, "rgt": 3}, {"lft": 22, "rgt": 22}]
		got, _ = M.propose_farm_group("Nowhere", "KR", self.GROUPS, leaves)
		self.assertNotEqual(got, "Karen Roses - KR")

	def test_a_greenhouse_leaf_name_points_at_its_farm(self):
		farms = ["Karen", "Torongo", "Kapkolia"]
		self.assertEqual(M.farm_named_leaf("KarenGH10 - KR", "KR", farms), "Karen")
		self.assertEqual(M.farm_named_leaf("Torongo GH18 - KR", "KR", farms), "Torongo")
		self.assertIsNone(M.farm_named_leaf("Main - KR", "KR", farms))
		self.assertIsNone(M.farm_named_leaf("Karen - KR", "KR", farms))

	def test_stores_csus_and_flocks_are_not_greenhouses(self):
		for name in ("Chemical Store Karen - KR", "Torongo CSU Phase 1 - KR", "Flock 8 - KR"):
			self.assertFalse(M._greenhouse_like(name), name)
		self.assertTrue(M._greenhouse_like("Torongo GH 18 - KR"))


if __name__ == "__main__":
	unittest.main()
