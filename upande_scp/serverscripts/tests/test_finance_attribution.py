"""finance_attribution.allocate: recorded, foliar, every band, both paths, priority. Pure."""

import unittest

from upande_scp.serverscripts.reports import finance_attribution as FAT

KB = {
	"alias": {"abamectin": "abamectin", "avermectin": "abamectin", "boscalid": "boscalid"},
	"kind": {"abamectin": "Insecticide", "boscalid": "Fungicide", "btk": "Biological"},
	"ai_t": {"abamectin": {"Mites": 3}, "boscalid": {"Mildew": 2}},
	"prod_ai": {"velumprime": ["abamectin"], "magnumgold": ["boscalid"]},
	"prods": {"magnumgold": ["Mildew"]},
}
KINDS = {"Mites": "pest", "Thrips": "pest", "Mildew": "disease", "Botrytis": "disease"}
T = ["Mites", "Thrips", "Mildew", "Botrytis"]


def refs(plans=None, mona=None):
	plans = plans or {}
	return {"plans": plans, "mona_ai_t": mona or {},
	        "use_dates": {c: [(d, w) for d, w, _ts in v] for c, v in plans.items()}}


def used(code, n, start="2026-08-01"):
	return {code: [(f"2026-08-{i + 1:02d}", f"U{i}") for i in range(n)]}


def alone_plans(code, target, n, start="2026-08-01"):
	return {code: [(f"2026-08-{i + 1:02d}", f"WO{i}", [target]) for i in range(n)]}


def prod(**kw):
	return {"code": "P1", "name": "Some Product", **kw}


def alloc(p, cands=T, r=None, **kw):
	return FAT.allocate(p, cands, r or refs(), KB, KINDS, on_date="2026-09-10", **kw)


class Base(unittest.TestCase):
	def assertShares(self, a, expected, basis, places=6):
		self.assertEqual(a["basis"], basis)
		self.assertEqual(set(a["shares"]), set(expected))
		for t, v in expected.items():
			self.assertAlmostEqual(a["shares"][t], v, places=places)
		if a["shares"]:
			self.assertAlmostEqual(sum(a["shares"].values()), 1.0, places=9)


class TestRecorded(Base):
	def test_recorded_split_equally_across_own_targets(self):
		self.assertShares(alloc(prod(), recorded=["Mites", "Mildew"]), {"Mites": .5, "Mildew": .5}, "recorded")

	def test_recorded_beats_every_derived_band(self):
		p = prod(name="Velum Prime", registered=["Thrips"], irac=True)
		r = refs(alone_plans("P1", "Thrips", 5))
		self.assertShares(alloc(p, r=r, recorded=["Botrytis"]), {"Botrytis": 1.0}, "recorded")

	def test_recorded_on_direct_path_too(self):
		self.assertShares(FAT.allocate(prod(), None, refs(), KB, KINDS, recorded=["Mites"]), {"Mites": 1.0}, "recorded")

	def test_credibility_recorded_is_100(self):
		c = FAT.credibility("recorded")
		self.assertEqual((c["kind"], c["label"], c["accuracy"]), ("recorded", "Recorded", 1.0))


class TestCostGroups(Base):
	def test_default_groups(self):
		d = FAT.default_cost_group
		self.assertEqual(d({"category": "Foliar"}), "Foliar")
		self.assertEqual(d({"code": "FER0004"}), "Foliar")
		self.assertEqual(d({"category": "Chemical", "type": "Adjuvant"}), "Adjuvant")
		self.assertEqual(d({"category": "Chemical", "type": "pH Buffer"}), "pH buffer")
		self.assertEqual(d({"category": "Chemical", "type": "Insecticide"}), "Pest control")

	def test_explicit_group_wins_over_default(self):
		self.assertEqual(FAT.cost_group({"category": "Chemical", "type": "Insecticide", "cost_group": "Post-harvest"}),
		                 "Post-harvest")
		self.assertEqual(FAT.cost_group({"category": "Foliar", "cost_group": "Pest control"}), "Pest control")
		self.assertEqual(FAT.cost_group({"type": "Adjuvant", "cost_group": "bogus"}), "Adjuvant")


class TestEvidence(Base):
	"""An empty cost group on the DIRECT path is decided from evidence, never from the name."""

	def direct(self, p, r=None):
		return FAT.allocate(p, None, r or refs(), KB, KINDS, on_date="2026-09-10")

	def test_used_on_spray_plans_is_pest_control_with_history_shares(self):
		r = refs(alone_plans("P1", "Mites", 3))
		r["use_dates"] = used("P1", 3)
		a = self.direct(prod(name="Anything"), r)
		self.assertEqual(a["basis"], "band2_alone")
		self.assertEqual(set(a["shares"]), {"Mites"})

	def test_used_on_plans_but_no_history_window_hit_is_unattributed_not_unclassified(self):
		r = refs()
		r["use_dates"] = used("P1", 2)
		self.assertEqual(self.direct(prod(), r)["basis"], "unattributed")

	def test_ingredient_evidence_is_pest_control(self):
		self.assertEqual(self.direct(prod(ingredients=["abamectin"]))["basis"], "band1_ai_target")

	def test_no_use_and_no_evidence_is_unclassified_with_no_shares(self):
		a = self.direct(prod())
		self.assertEqual((a["basis"], a["shares"], a["group"]), ("unclassified", {}, "Unclassified"))

	def test_explicit_group_beats_evidence(self):
		r = refs(alone_plans("P1", "Mites", 3))
		r["use_dates"] = used("P1", 3)
		a = self.direct(prod(cost_group="Hygiene & sanitation"), r)
		self.assertEqual((a["basis"], a["group"]), ("non_pest", "Hygiene & sanitation"))
		a = self.direct(prod(cost_group="Pest control"))
		self.assertEqual(a["basis"], "unattributed")  # explicit Pest control, nothing known to place it

	def test_a_spray_plan_line_is_never_unclassified(self):
		self.assertEqual(alloc(prod())["basis"], "equal")

	def test_names_do_not_classify(self):
		for n in ("Agrowipe", "Chrysal Inicial", "hydrogen peroxide", "Flower Dust"):
			self.assertEqual(self.direct(prod(name=n))["basis"], "unclassified")


class TestFoliar(Base):
	def test_foliar_category_equal_over_plan_targets(self):
		self.assertShares(alloc(prod(category="Foliar")), dict.fromkeys(T, .25), "foliar_equal")

	def test_fer_item_is_foliar(self):
		self.assertEqual(alloc(prod(code="FER0004"))["basis"], "foliar_equal")

	def test_adjuvant_and_ph_buffer_split_equally_and_carry_their_group(self):
		for t, g in (("Adjuvant", "Adjuvant"), ("pH Buffer", "pH buffer")):
			a = alloc(prod(category="Chemical", type=t))
			self.assertShares(a, dict.fromkeys(T, .25), "foliar_equal")
			self.assertEqual(a["group"], g)

	def test_foliar_ignores_recorded_and_registration(self):
		a = alloc(prod(category="Foliar", registered=["Mites"]), recorded=["Mites"])
		self.assertShares(a, dict.fromkeys(T, .25), "foliar_equal")

	def test_foliar_no_targets_is_farm_level(self):
		a = alloc(prod(category="Foliar"), cands=[])
		self.assertEqual((a["basis"], a["shares"]), ("foliar_farm", {}))

	def test_split_groups_direct_not_split(self):
		for p in (prod(category="Foliar"), prod(type="Adjuvant"), prod(type="pH Buffer")):
			a = FAT.allocate(p, None, refs(), KB, KINDS)
			self.assertEqual((a["basis"], a["shares"]), ("foliar_farm", {}))

	def test_hygiene_and_post_harvest_never_split_on_either_path(self):
		for g in ("Hygiene & sanitation", "Post-harvest"):
			p = prod(cost_group=g, registered=["Mites"], ingredients=["abamectin"])
			spray = alloc(p, recorded=["Mites"])
			direct = FAT.allocate(p, None, refs(), KB, KINDS, recorded=["Mites"])
			for a in (spray, direct):
				self.assertEqual((a["basis"], a["shares"], a["group"]), ("non_pest", {}, g))

	def test_pest_control_override_of_a_foliar_category_uses_the_bands(self):
		a = alloc(prod(category="Foliar", cost_group="Pest control", ingredients=["abamectin"]))
		self.assertEqual(a["basis"], "band1_ai_target")

	def test_credibility_non_pest_labels(self):
		self.assertEqual(FAT.credibility("foliar_equal")["kind"], "nonpest")
		self.assertEqual(FAT.credibility("non_pest")["label"], "Not target-specific")


class TestSprayBands(Base):
	def test_band1_ai_target_via_seed_product_name(self):
		a = alloc(prod(name="VELUM PRIME 400SC"))
		self.assertShares(a, {"Mites": 1.0}, "band1_ai_target")

	def test_band1_ai_target_equal_inside_subset_without_history(self):
		a = alloc(prod(ingredients=["Abamectin"], registered=["Thrips"]))
		self.assertShares(a, {"Mites": .5, "Thrips": .5}, "band1_ai_target")

	def test_band1_weights_inside_subset_by_band2(self):
		p = prod(ingredients=["abamectin"], registered=["Thrips"])
		r = refs(alone_plans("P1", "Mites", 3))
		a = alloc(p, r=r)
		w = {"Mites": (3 + .25) ** 2, "Thrips": .25 ** 2}
		tot = sum(w.values())
		self.assertShares(a, {k: v / tot for k, v in w.items()}, "band1_ai_target")

	def test_band1_weights_fall_to_band3_when_alone_insufficient(self):
		p = prod(ingredients=["abamectin"], registered=["Thrips"])
		plans = {"P1": [("2026-08-01", "A", ["Mites", "Thrips"]), ("2026-08-02", "B", ["Mites", "Botrytis"]),
		                ("2026-08-03", "C", ["Mites"])]}
		a = alloc(p, r=refs(plans))
		# only ONE single-target plan, so band 2 is unavailable; radar: Mites 2.0, Thrips .5
		w = {"Mites": (2.0 + .5) ** 2, "Thrips": (.5 + .5) ** 2}
		tot = sum(w.values())
		self.assertShares(a, {k: v / tot for k, v in w.items()}, "band1_ai_target")

	def test_mona_registrations_aggregated_by_ingredient(self):
		p = prod(ingredients=["Fluopyram"])
		a = alloc(p, r=refs(mona={"fluopyram": {"Botrytis": 2}}))
		self.assertShares(a, {"Botrytis": 1.0}, "band1_ai_target")

	def test_prefix_name_match_needs_five_chars(self):
		self.assertEqual(FAT.match_product_name(["Velum Prime Plus"], KB), "velumprime")
		self.assertIsNone(FAT.match_product_name(["Vel"], KB))

	def test_band1_ai_class_pests_only(self):
		a = alloc(prod(ingredients=["Unknown"], irac=True))
		self.assertShares(a, {"Mites": .5, "Thrips": .5}, "band1_ai_class")

	def test_band1_ai_class_fungicide_diseases(self):
		a = alloc(prod(frac=True))
		self.assertShares(a, {"Mildew": .5, "Botrytis": .5}, "band1_ai_class")

	def test_class_not_used_when_it_covers_all_of_T(self):
		a = alloc(prod(irac=True, frac=True))
		self.assertEqual(a["basis"], "equal")

	def test_band2_alone(self):
		a = alloc(prod(), r=refs(alone_plans("P1", "Mildew", 4)))
		w = {t: ((4 if t == "Mildew" else 0) + .25) ** 2 for t in T}
		tot = sum(w.values())
		self.assertShares(a, {k: v / tot for k, v in w.items()}, "band2_alone")

	def test_band2_needs_two_plans_and_a_hit_in_T(self):
		self.assertNotEqual(alloc(prod(), r=refs(alone_plans("P1", "Mildew", 1)))["basis"], "band2_alone")
		self.assertNotEqual(alloc(prod(), ["Mites", "Thrips"], refs(alone_plans("P1", "Mildew", 4)))["basis"], "band2_alone")

	def test_band2_window_is_180_days_before_the_line(self):
		plans = {"P1": [("2026-01-01", "A", ["Mildew"]), ("2026-01-02", "B", ["Mildew"])]}
		self.assertNotEqual(alloc(prod(), r=refs(plans))["basis"], "band2_alone")  # >180 days old
		plans = {"P1": [("2026-09-10", "A", ["Mildew"]), ("2026-09-11", "B", ["Mildew"])]}
		self.assertNotEqual(alloc(prod(), r=refs(plans))["basis"], "band2_alone")  # not before the line

	def test_own_plan_excluded_from_history(self):
		plans = {"P1": [("2026-08-01", "SELF", ["Mildew"]), ("2026-08-02", "B", ["Mildew"])]}
		self.assertNotEqual(alloc(prod(), r=refs(plans), exclude_wo="SELF")["basis"], "band2_alone")

	def test_band3_radar(self):
		plans = {"P1": [("2026-08-01", "A", ["Mites", "Mildew"]), ("2026-08-02", "B", ["Mites", "Thrips"]),
		                ("2026-08-03", "C", ["Mites", "Botrytis"])]}
		a = alloc(prod(), r=refs(plans))
		self.assertEqual(a["basis"], "band3_radar")
		w = {"Mites": (1.5 + .5) ** 2, "Thrips": 1.0, "Mildew": 1.0, "Botrytis": 1.0}
		tot = sum(w.values())
		self.assertShares(a, {k: v / tot for k, v in w.items()}, "band3_radar")

	def test_equal_is_the_last_resort(self):
		self.assertShares(alloc(prod()), dict.fromkeys(T, .25), "equal")

	def test_empty_T_is_unattributed(self):
		a = alloc(prod(), cands=[])
		self.assertEqual((a["basis"], a["shares"]), ("unattributed", {}))

	def test_priority_band1_over_band2(self):
		p = prod(ingredients=["abamectin"])
		a = alloc(p, r=refs(alone_plans("P1", "Botrytis", 5)))
		self.assertEqual(set(a["shares"]), {"Mites"})  # ingredient target wins over what history says

	def test_shares_always_sum_to_one(self):
		for p in (prod(), prod(irac=True), prod(ingredients=["abamectin"]), prod(category="Foliar")):
			a = alloc(p)
			self.assertAlmostEqual(sum(a["shares"].values()), 1.0, places=9)

	def test_credibility_derived_carries_accuracy(self):
		for basis, pct in (("band1_ai_target", 89), ("band1_ai_class", 64), ("band2_alone", 93),
		                   ("band3_radar", 67), ("equal", 38)):
			c = FAT.credibility(basis, "spray")
			self.assertEqual(c["kind"], "derived")
			self.assertIn(f"est. {pct}%", c["label"])
			self.assertTrue(c["label"].startswith("Derived"))


class TestDirectPath(Base):
	def direct(self, p, r=None, **kw):
		return FAT.allocate(p, None, r or refs(), KB, KINDS, on_date="2026-09-10", **kw)

	def test_band1_ingredient_targets_without_candidate_set(self):
		self.assertShares(self.direct(prod(ingredients=["abamectin"])), {"Mites": 1.0}, "band1_ai_target")

	def test_band1_weighted_by_alone_restricted_to_its_set(self):
		p = prod(ingredients=["abamectin"], registered=["Thrips"])
		r = refs(alone_plans("P1", "Thrips", 3))
		a = self.direct(p, r)
		w = {"Mites": .25 ** 2, "Thrips": (3 + .25) ** 2}
		tot = sum(w.values())
		self.assertShares(a, {k: v / tot for k, v in w.items()}, "band1_ai_target")

	def test_band2_alone_over_targets_it_was_used_alone_for(self):
		plans = {"P1": [("2026-08-01", "A", ["Mildew"]), ("2026-08-02", "B", ["Mildew"]), ("2026-08-03", "C", ["Mites"])]}
		a = self.direct(prod(), refs(plans))
		w = {"Mildew": (2 + .25) ** 2, "Mites": (1 + .25) ** 2}
		tot = sum(w.values())
		self.assertShares(a, {k: v / tot for k, v in w.items()}, "band2_alone")

	def test_band3_radar(self):
		plans = {"P1": [("2026-08-01", "A", ["Mites", "Mildew"]), ("2026-08-02", "B", ["Mites", "Thrips"]),
		                ("2026-08-03", "C", ["Mites", "Botrytis"])]}
		a = self.direct(prod(), refs(plans))
		self.assertEqual(a["basis"], "band3_radar")
		self.assertAlmostEqual(sum(a["shares"].values()), 1.0)

	def test_nothing_known_is_never_split_equally(self):
		a = self.direct(prod())
		self.assertEqual((a["basis"], a["shares"]), ("unclassified", {}))
		r = refs()
		r["use_dates"] = used("P1", 1)  # used on a plan, but nothing to attribute by
		self.assertEqual(self.direct(prod(), r)["basis"], "unattributed")

	def test_direct_accuracy_labels(self):
		self.assertIn("est. 84%", FAT.credibility("band2_alone", "direct")["label"])
		self.assertIn("est. 45%", FAT.credibility("band3_radar", "direct")["label"])


class TestReferenceBuild(unittest.TestCase):
	def test_build_plans_filters_invalid_targets_and_dedupes(self):
		rows = [
			{"wo": "A", "targets": "Mites\nBogus", "item_code": "P1", "date": "2026-08-02"},
			{"wo": "A", "targets": "Mites\nBogus", "item_code": "P1", "date": "2026-08-02"},
			{"wo": "B", "targets": "Bogus", "item_code": "P1", "date": "2026-08-01"},
		]
		self.assertEqual(FAT.build_plans(rows, KINDS), {"P1": [("2026-08-02", "A", ["Mites"])]})

	def test_seed_ships_with_the_app(self):
		kb = FAT.load_seed()
		for k in ("alias", "kind", "ai_t", "prod_ai", "prods"):
			self.assertTrue(kb[k])


class TestNoLookAheadAndRecordedHistory(unittest.TestCase):
	def test_plan_uses_are_counted_before_the_line_not_the_report_end(self):
		r = refs()
		r["use_dates"] = {"P1": [("2026-09-20", "A"), ("2026-09-25", "B")]}
		self.assertEqual(FAT.uses_before(r, "P1", "2026-09-10"), 0)  # both are AFTER the line
		self.assertEqual(FAT.uses_before(r, "P1", "2026-09-22"), 1)
		self.assertEqual(FAT.uses_before(r, "P1", "2026-09-30"), 2)
		self.assertEqual(FAT.uses_before(r, "P1", "2026-09-30", exclude_wo="A"), 1)
		self.assertEqual(FAT.uses_before(r, "P1", "2027-09-30"), 0)  # older than a year

	def test_a_direct_line_before_any_use_is_unclassified_not_pest_control(self):
		r = refs()
		r["use_dates"] = {"P1": [("2026-09-20", "A")]}
		a = FAT.allocate(prod(), None, r, KB, KINDS, on_date="2026-09-10")
		self.assertEqual(a["basis"], "unclassified")
		a = FAT.allocate(prod(), None, r, KB, KINDS, on_date="2026-09-30")
		self.assertEqual(a["basis"], "unattributed")

	def test_recorded_row_targets_feed_history_and_rows_of_one_item_merge(self):
		rows = [
			{"wo": "A", "targets": "Mites\nMildew", "item_code": "P1", "date": "2026-08-02", "row_targets": "Mites"},
			{"wo": "A", "targets": "Mites\nMildew", "item_code": "P1", "date": "2026-08-02", "row_targets": "Mildew"},
			{"wo": "B", "targets": "Mites\nMildew", "item_code": "P1", "date": "2026-08-03", "row_targets": "Thrips"},
			{"wo": "C", "targets": "Mites\nMildew", "item_code": "P1", "date": "2026-08-04", "row_targets": None},
		]
		got = FAT.build_plans(rows, KINDS)["P1"]
		self.assertEqual(got[0], ("2026-08-02", "A", ["Mites", "Mildew"]))  # both rows merged
		self.assertEqual(got[1], ("2026-08-03", "B", ["Thrips"]))  # a recorded single-target row = used alone
		self.assertEqual(got[2], ("2026-08-04", "C", ["Mites", "Mildew"]))  # no row targets: the plan's

	def test_version_token_changes_the_cache_key(self):
		import frappe
		before = FAT._version()
		FAT.bump_reference_version()
		self.assertNotEqual(FAT._version(), before)
