"""allocate_product_cost (each level, priority) and the usage-radar maths. Pure."""

import unittest

from upande_scp.serverscripts.reports import finance_allocation as FA

KINDS = {"Mites": "pest", "Thrips": "pest", "Mildew": "disease", "Botrytis": "disease"}
T = ["Mites", "Thrips", "Mildew", "Botrytis"]


def alloc(product, targets=T):
    return FA.allocate_product_cost(product, targets, KINDS)


class TestLevels(unittest.TestCase):
    def assertShares(self, a, expected, basis):
        self.assertEqual(a["basis"], basis)
        self.assertEqual(set(a["shares"]), set(expected))
        for t, v in expected.items():
            self.assertAlmostEqual(a["shares"][t], v, places=6)
        self.assertAlmostEqual(sum(a["shares"].values()), 1.0, places=9)

    def test_registered_equal_without_history(self):
        self.assertShares(alloc({"registered": ["Mites", "Mildew", "Other"]}), {"Mites": .5, "Mildew": .5}, "registered")

    def test_registered_weighted_by_history(self):
        a = alloc({"registered": ["Mites", "Mildew"], "history_plans": 4, "history": {"Mites": 3.5, "Mildew": 0.0}})
        self.assertShares(a, {"Mites": 4 / 4.5, "Mildew": 0.5 / 4.5}, "registered")

    def test_history_ignored_below_min_plans_for_weights(self):
        a = alloc({"registered": ["Mites", "Mildew"], "history_plans": 2, "history": {"Mites": 2.0}})
        self.assertShares(a, {"Mites": .5, "Mildew": .5}, "registered")

    def test_registered_beats_nutrition(self):
        a = alloc({"registered": ["Mites"], "category": "Foliar"})
        self.assertShares(a, {"Mites": 1.0}, "registered")

    def test_nutrition_for_foliar_and_adjuvant(self):
        for p in ({"category": "Foliar"}, {"type": "Adjuvant"}, {"type": "pH Buffer"}):
            self.assertShares(alloc({**p, "irac": True}), {FA.NUTRITION: 1.0}, "nutrition")

    def test_nutrition_beats_ai_class_and_history(self):
        a = alloc({"category": "Foliar", "frac": True, "history_plans": 9, "history": {"Mildew": 9}})
        self.assertEqual(a["basis"], "nutrition")

    def test_irac_only_pests(self):
        self.assertShares(alloc({"irac": True}), {"Mites": .5, "Thrips": .5}, "ai_class")

    def test_frac_only_diseases(self):
        self.assertShares(alloc({"frac": True}), {"Mildew": .5, "Botrytis": .5}, "ai_class")

    def test_both_classes_cover_everything_known(self):
        self.assertShares(alloc({"irac": True, "frac": True}), dict.fromkeys(T, .25), "ai_class")

    def test_ai_class_weighted_by_history(self):
        a = alloc({"irac": True, "history_plans": 3, "history": {"Mites": 1.5, "Thrips": 0.0}})
        self.assertShares(a, {"Mites": 0.8, "Thrips": 0.2}, "ai_class")

    def test_ai_class_skipped_when_subset_empty(self):
        a = alloc({"irac": True}, ["Mildew", "Botrytis"])
        self.assertShares(a, {"Mildew": .5, "Botrytis": .5}, "equal")

    def test_history_level(self):
        a = alloc({"history_plans": 5, "history": {"Mites": 4.0, "Mildew": 1.0}}, ["Mites", "Mildew", "Botrytis"])
        # smoothed: 4.5, 1.5, 0.5 over 6.5
        self.assertShares(a, {"Mites": 4.5 / 6.5, "Mildew": 1.5 / 6.5, "Botrytis": .5 / 6.5}, "history")

    def test_history_needs_three_plans(self):
        a = alloc({"history_plans": 2, "history": {"Mites": 2.0}}, ["Mites", "Mildew"])
        self.assertShares(a, {"Mites": .5, "Mildew": .5}, "equal")

    def test_equal_fallback(self):
        self.assertShares(alloc({}), dict.fromkeys(T, .25), "equal")

    def test_no_targets_is_unattributed(self):
        a = alloc({"registered": ["Mites"]}, [])
        self.assertEqual(a, {"shares": {}, "basis": "unattributed"})

    def test_duplicate_targets_collapse(self):
        self.assertShares(alloc({}, ["Mites", "Mites", "Mildew"]), {"Mites": .5, "Mildew": .5}, "equal")


class TestRadar(unittest.TestCase):
    ROWS = [
        {"wo": "W1", "targets": "Mites", "item_code": "a"},
        {"wo": "W1", "targets": "Mites", "item_code": "b"},
        {"wo": "W2", "targets": "Mites\nMildew", "item_code": "a"},
        {"wo": "W2", "targets": "Mites\nMildew", "item_code": "a"},  # same item twice: one plan
        {"wo": "W3", "targets": "Re-bending", "item_code": "a"},  # no valid target: ignored
        {"wo": "W4", "targets": "Thrips\nMites\nMildew\nRe-bending", "item_code": "b"},
    ]

    def test_weights_and_plan_counts(self):
        r = FA.build_radar(self.ROWS, KINDS)
        self.assertEqual(r["a"]["plans"], 2)
        self.assertEqual(r["a"]["targets"], {"Mites": 1.5, "Mildew": 0.5})
        self.assertEqual(r["b"]["plans"], 2)
        self.assertAlmostEqual(r["b"]["targets"]["Mites"], 1 + 1 / 3)
        self.assertAlmostEqual(sum(r["b"]["targets"].values()), 2.0)

    def test_suggestions(self):
        entry = {"plans": 10, "targets": {"Mites": 6.0, "Mildew": 3.0, "Thrips": 1.0}}
        s = FA.suggestions_from_radar(entry, KINDS)
        self.assertEqual([x["target"] for x in s], ["Mites", "Mildew"])
        self.assertAlmostEqual(s[0]["share"], 0.6)

    def test_no_suggestion_under_three_plans(self):
        self.assertEqual(FA.suggestions_from_radar({"plans": 2, "targets": {"Mites": 2.0}}, KINDS), [])
