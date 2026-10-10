"""Stage & variety (piece 4): stage roles, the live / signs split and weighted
counts over hand-built rows. Plain pytest, no site."""

import unittest
from importlib import import_module

from upande_scp.serverscripts.common import stage_roles as S

R = import_module("upande_scp.serverscripts.dashboard_aggregates._prevalence_rows")

# 27 stations, 3 in each of the 9 sections (the test_prevalence_rows_pure shape).
GRID = {f"Z{r}{c}{k}": (r, c) for r in range(3) for c in range(3) for k in range(3)}
YW, WEEK = 203144, "2031-W44"


def kth(k):
    """Station k (0, 1 or 2) of every section."""
    return sorted(n for n in GRID if n.endswith(str(k)))


def scouted(wh, yw, stations, in_win=1):
    return [{"wh": wh, "station": s, "yw": yw, "in_win": in_win} for s in stations]


def rows(wh, yw, stations, stage, obs="Thrips", kind="pest", count=0):
    return [{"wh": wh, "station": s, "yw": yw, "kind": kind, "obs": obs, "stage": stage,
             "section": "Leaf", "count": count} for s in stations]


def weeks(scouted_rows, infested_rows, roles=None):
    return R.StationWeeks(scouted_rows, infested_rows, grid_loader=lambda wh: dict(GRID), roles=roles)


CAT_STAGES = [
    {"name": "Eggs", "stage_role": None, "weight": 0.5},
    {"name": "Web", "stage_role": "Sign", "weight": 1},
]
CAT_FILTERS = [
    {"crop": "Rose", "pest": "Spidermites", "stage": "Eggs", "weight": 0.25},
    {"crop": "Rose", "pest": "Spidermites", "stage": "Web", "weight": 0},
    {"crop": "Rose", "pest": "Whiteflies", "stage": "Eggs", "weight": 0},
]


class TestStageRoles(unittest.TestCase):
    def test_the_seed_names_signs_and_forms_and_everything_else_is_a_life_stage(self):
        self.assertEqual([S.seed_role(s) for s in S.SEED_SIGNS], ["Sign"] * 5)
        self.assertEqual(S.SEED_SIGNS, ("Damage", "Damages", "FCM Damage", "Web", "Ragged Margins"))
        self.assertEqual([S.seed_role(s) for s in S.SEED_FORMS], ["Form"] * 7)
        self.assertEqual(S.SEED_FORMS, ("Motiles", "Singles", "Colonies", "Scales", "Scale Insects",
                                        "Adult Cloud", "Adult Singles"))
        self.assertEqual([S.seed_role(s) for s in ("Eggs", "Adult", "Larvae", "Egg Sacs", "Fresh", "", None)],
                         ["Life stage"] * 7)

    def test_a_blank_unknown_or_unlisted_role_reads_as_a_life_stage(self):
        roles = {"Damages": "Sign", "Eggs": "", "Odd": "Weird"}
        self.assertEqual([S.role_of(s, roles) for s in ("Damages", " Damages ", "Eggs", "Odd", "Unlisted", "", None)],
                         ["Sign", "Sign", "Life stage", "Life stage", "Life stage", "Life stage", "Life stage"])
        self.assertTrue(S.is_live("Motiles", {"Motiles": "Form"}))
        self.assertFalse(S.is_live("Damages", roles))

    def test_an_override_wins_zero_inherits_and_a_master_zero_stays_zero(self):
        self.assertEqual(S.resolve_weight(1.0, 0.25), 0.25)
        self.assertEqual(S.resolve_weight(0.5, 0), 0.5)
        self.assertEqual(S.resolve_weight(0.5, None), 0.5)
        self.assertEqual(S.resolve_weight(0.0, None), 0.0)
        self.assertEqual(S.resolve_weight(None, None), 1.0)
        self.assertEqual(S.resolve_weight(-2, None), 0.0)

    def test_build_folds_the_master_and_the_per_crop_overrides(self):
        cat = S.build(CAT_STAGES, CAT_FILTERS)
        self.assertEqual(cat["roles"], {"Eggs": "Life stage", "Web": "Sign"})
        self.assertEqual(cat["weights"], {"Eggs": 0.5, "Web": 1.0})
        self.assertEqual(cat["pests"], {"Rose": {"Spidermites": {"Eggs": 0.25, "Web": 1.0},
                                                 "Whiteflies": {"Eggs": 0.5}}})

    def test_weights_and_sign_stages_are_read_per_crop_and_pest(self):
        cat = S.build(CAT_STAGES, CAT_FILTERS)
        self.assertEqual(S.weight_in(cat, "Rose", "Spidermites", "Eggs"), 0.25)
        self.assertEqual(S.weight_in(cat, "Rose", "Aphids", "Eggs"), 0.5)          # not on that row: the master
        self.assertEqual(S.weight_in(cat, "Rose", "Spidermites", "Unknown"), 1.0)
        self.assertEqual(S.signs_in(cat, "Rose", "Spidermites"), ["Web"])
        self.assertEqual(S.signs_in(cat, "Rose", "Whiteflies"), [])
        self.assertEqual(S.signs_in(cat, "Rose"), ["Web"])                           # any pest of the crop
        self.assertEqual(S.signs_in(cat, "Avocado"), [])
        self.assertEqual(S.signs_in(cat, ""), [])


class TestLiveAndSigns(unittest.TestCase):
    """Adult on station 0 of each section; Damages on stations 0 and 1."""

    def setUp(self):
        self.w = weeks(scouted("GH A", YW, GRID),
                       rows("GH A", YW, kth(0), "Adult") + rows("GH A", YW, kth(0) + kth(1), "Damages"))

    def test_a_station_with_only_a_sign_is_not_infested_for_the_live_figure(self):
        live = self.w.infested_set("GH A", WEEK, "pest", "Thrips")
        self.assertEqual(live, set(kth(0)))
        self.assertNotIn("Z001", live)
        self.assertEqual(self.w.latest("GH A", "pest", "Thrips")["prevalence"], 33.3)   # was 66.7 before S3

    def test_signs_are_their_own_figure(self):
        self.assertEqual(self.w.infested_set("GH A", WEEK, "pest", "Thrips", role=R.SIGNS), set(kth(0) + kth(1)))
        self.assertEqual(self.w.latest("GH A", "pest", "Thrips", role=R.SIGNS)["prevalence"], 66.7)
        self.assertEqual(self.w.combined_latest("pest", "Thrips", role=R.SIGNS)["prevalence"], 66.7)
        self.assertEqual(self.w.combined(WEEK, "pest", "Thrips", role=R.SIGNS)["prevalence"], 66.7)

    def test_a_named_sign_stage_still_measures_the_sign(self):
        self.assertEqual(self.w.latest("GH A", "pest", "Thrips", "Damages")["prevalence"], 66.7)
        self.assertEqual(self.w.latest("GH A", "pest", "Thrips", "Damages", role=R.SIGNS)["prevalence"], 66.7)
        self.assertEqual(self.w.latest("GH A", "pest", "Thrips", "Adult")["prevalence"], 33.3)

    def test_any_pest_reads_live_too(self):
        self.assertEqual(self.w.latest("GH A", "pest")["prevalence"], 33.3)
        self.assertEqual(self.w.latest("GH A", "pest", role=R.SIGNS)["prevalence"], 66.7)

    def test_diseases_ignore_roles(self):
        w = weeks(scouted("GH A", YW, GRID), rows("GH A", YW, kth(0), "Damages", obs="Botrytis", kind="disease"))
        self.assertEqual(w.latest("GH A", "disease", "Botrytis")["prevalence"], 33.3)
        self.assertEqual(w.latest("GH A", "disease", "Botrytis", role=R.SIGNS)["prevalence"], 33.3)

    def test_the_roles_given_decide(self):
        eggs = (scouted("GH A", YW, GRID), rows("GH A", YW, kth(0), "Eggs"))
        self.assertEqual(weeks(*eggs).latest("GH A", "pest", "Thrips")["prevalence"], 33.3)
        self.assertEqual(weeks(*eggs, roles={"Eggs": "Sign"}).latest("GH A", "pest", "Thrips")["prevalence"], 0.0)
        damages = (scouted("GH A", YW, GRID), rows("GH A", YW, kth(0), "Damages"))
        # No roles at all: every stage is a life stage — the pre-S3 figure.
        self.assertEqual(weeks(*damages, roles={}).latest("GH A", "pest", "Thrips")["prevalence"], 33.3)

    def test_a_pest_row_with_no_stage_is_live(self):
        w = weeks(scouted("GH A", YW, GRID), rows("GH A", YW, kth(0), "", count=2))
        self.assertEqual(w.latest("GH A", "pest", "Thrips")["prevalence"], 33.3)


class TestWeightedCounts(unittest.TestCase):
    """Spidermites on station 0 of each section: Adult 3 and Eggs 6."""

    def setUp(self):
        self.w = weeks(scouted("GH A", YW, GRID),
                       rows("GH A", YW, kth(0), "Adult", obs="Spidermites", count=3)
                       + rows("GH A", YW, kth(0), "Eggs", obs="Spidermites", count=6))
        self.stages = frozenset({"Adult", "Eggs"})

    def counts(self, weights=None):
        return self.w.station_counts("GH A", WEEK, "pest", "Spidermites", self.stages, weights=weights)

    def test_weights_of_one_reproduce_the_plain_sum(self):
        self.assertEqual(self.counts()["Z000"], 9.0)
        self.assertEqual(self.counts((("Adult", 1.0), ("Eggs", 1.0))), self.counts())

    def test_half_weight_on_eggs_halves_their_contribution(self):
        self.assertEqual(self.counts({"Eggs": 0.5})["Z000"], 6.0)
        fig = self.w.count_latest("GH A", "pest", "Spidermites", self.stages, weights=(("Eggs", 0.5),))
        self.assertEqual(fig["value"], 2.0)                                 # (3 + 0.5·6) / 3 per section

    def test_a_zero_weight_drops_the_stage(self):
        self.assertEqual(self.counts({"Eggs": 0})["Z000"], 3.0)

    def test_weighted_and_plain_figures_are_memoised_apart(self):
        vals = [self.w.count_figures("GH A", WEEK, "pest", "Spidermites", self.stages, weights=w)["value"]
                for w in (None, (("Eggs", 0.5),), None, (("Eggs", 1.0),))]
        self.assertEqual(vals, [3.0, 2.0, 3.0, 3.0])
