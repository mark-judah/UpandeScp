"""Pure tests for the floor plan's active-ingredient maths and the suggested-mix search.

DB-backed behaviour (covered-target filtering, suggest_mix against real stock) lives in
`test_afp_suggest_and_batches`.
"""

import unittest

from upande_scp.serverscripts.spray_compliance import active_ingredients as AI
from upande_scp.serverscripts.spray_compliance import suggest as S


class TestAiAmount(unittest.TestCase):
	def amt(self, *a, **k):
		r = AI.ai_amount(*a, **k)
		return r["status"], r["amount"], r["amount_unit"]

	def test_g_per_litre_times_litres_is_grams(self):
		self.assertEqual(self.amt(3, "Litre", 18, "g/L"), ("ok", 54.0, "g"))
		self.assertEqual(self.amt(500, "ml", 18, "g/L"), ("ok", 9.0, "g"))

	def test_g_per_kg_times_kg_is_grams(self):
		self.assertEqual(self.amt(2, "Kg", 750, "g/kg"), ("ok", 1500.0, "g"))
		self.assertEqual(self.amt(500, "Gram", 750, "g/kg"), ("ok", 375.0, "g"))

	def test_percent_follows_the_quantity_dimension(self):
		# w/v: 2 L of a 5 % product = 2 x 10 x 5 = 100 g
		self.assertEqual(self.amt(2, "Litre", 5, "%"), ("ok", 100.0, "g"))
		# w/w: 2 kg of a 5 % product = 100 g
		self.assertEqual(self.amt(2, "Kg", 5, "%"), ("ok", 100.0, "g"))

	def test_biologicals_give_counts(self):
		s, v, u = self.amt(2, "Kg", 1e9, "CFU/g")
		self.assertEqual((s, u), ("ok", "CFU"))
		self.assertAlmostEqual(v, 2e12)
		s, v, u = self.amt(1.5, "Litre", 1e8, "CFU/mL")
		self.assertAlmostEqual(v, 1.5e11)
		s, v, u = self.amt(2, "Litre", 5e6, "OB/mL")
		self.assertEqual(u, "OB")
		self.assertAlmostEqual(v, 1e10)

	def test_custom_uom_factor_is_applied_first(self):
		# 4 bottles of 0.5 L each, 18 g/L -> 36 g
		self.assertEqual(self.amt(4, "Litre", 18, "g/L", uom_factor=0.5), ("ok", 36.0, "g"))

	def test_missing_concentration_or_unit_is_never_guessed(self):
		for conc, unit in ((None, "g/L"), (0, "g/L"), (18, None), (18, "")):
			self.assertEqual(self.amt(3, "Litre", conc, unit), ("no_concentration", None, None))

	def test_dimension_mismatch_and_unknown_uom_and_no_qty(self):
		self.assertEqual(self.amt(3, "Kg", 18, "g/L")[0], "unit_mismatch")
		self.assertEqual(self.amt(3, "Litre", 18, "g/kg")[0], "unit_mismatch")
		self.assertEqual(self.amt(3, "Litre", 1e9, "CFU/g")[0], "unit_mismatch")
		self.assertEqual(self.amt(3, "Bottle", 18, "g/L")[0], "unit_mismatch")
		self.assertEqual(self.amt(0, "Litre", 18, "g/L")[0], "no_quantity")


class TestMixSearch(unittest.TestCase):
	def e(self, code, covers, score=50):
		return {"item_code": code, "item_name": code, "covered_targets": covers, "score": score}

	def run_search(self, entries, wanted, clash=()):
		"""`clash` = pairs that may not share a tank."""
		def valid(items):
			return not any(a in items and b in items for a, b in clash)
		return S.search_mixes(entries, wanted, [], valid=valid)

	def codes(self, mixes):
		return [sorted(e["item_code"] for e in m) for m in mixes]

	def test_covers_every_target_fewest_products_first(self):
		es = [self.e("A", ["t1"]), self.e("B", ["t2"]), self.e("AB", ["t1", "t2"], 40)]
		out = self.codes(self.run_search(es, ["t1", "t2"]))
		self.assertEqual(out[0], ["AB"])
		self.assertIn(["A", "B"], out)

	def test_every_mix_covers_all_targets_and_every_product_earns_its_place(self):
		es = [self.e("A", ["t1"]), self.e("B", ["t2"]), self.e("C", ["t3"]), self.e("AB", ["t1", "t2"])]
		for mix in self.run_search(es, ["t1", "t2", "t3"]):
			got = set().union(*(set(e["covered_targets"]) for e in mix))
			self.assertEqual(got, {"t1", "t2", "t3"})
			for e in mix:
				rest = set().union(*(set(o["covered_targets"]) for o in mix if o is not e))
				self.assertNotEqual(rest, {"t1", "t2", "t3"})

	def test_two_products_that_may_not_share_a_tank_are_never_proposed_together(self):
		es = [self.e("A", ["t1"]), self.e("B", ["t2"])]
		self.assertEqual(self.run_search(es, ["t1", "t2"], clash=[("A", "B")]), [])

	def test_a_clash_steers_to_a_compatible_alternative(self):
		es = [self.e("A", ["t1"]), self.e("B", ["t2"]), self.e("C", ["t2"], 30)]
		out = self.codes(self.run_search(es, ["t1", "t2"], clash=[("A", "B")]))
		self.assertEqual(out, [["A", "C"]])

	def test_higher_score_wins_among_equal_sizes_and_alternatives_are_capped(self):
		es = [self.e("A", ["t1"], 90), self.e("A2", ["t1"], 10), self.e("A3", ["t1"], 20),
		      self.e("A4", ["t1"], 30)]
		mixes = self.run_search(es, ["t1"])
		self.assertEqual(len(mixes), S.MIX_ALTERNATIVES)
		self.assertEqual(mixes[0][0]["item_code"], "A")

	def test_a_target_nobody_covers_gives_no_mix(self):
		self.assertEqual(self.run_search([self.e("A", ["t1"])], ["t1", "t2"]), [])


class TestScoreStructure(unittest.TestCase):
	def test_effectiveness_is_reserved_and_adds_nothing_while_unscored(self):
		c = S.score_components(1, 1, None, 60, False, 0, None, [])
		self.assertIn("effectiveness", c)
		self.assertIsNone(c["effectiveness"])
		self.assertAlmostEqual(S.total_score(c), S.W_COVERAGE + S.W_ROTATION + S.W_STOCK + S.W_COST / 2)
		c["effectiveness"] = 10
		self.assertAlmostEqual(S.total_score(c), S.W_COVERAGE + S.W_ROTATION + S.W_STOCK + S.W_COST / 2 + 10)


def run():
	r = unittest.TextTestRunner(verbosity=2).run(
		unittest.defaultTestLoader.loadTestsFromModule(__import__(__name__, fromlist=["x"])))
	return r.wasSuccessful()
