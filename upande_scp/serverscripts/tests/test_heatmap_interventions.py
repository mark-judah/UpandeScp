"""Interventions between scouting weeks: matching and the before/after delta.

Pure tests need no site. The DB class builds its own ThrowawayPlan (never a real
plan) and reads it back through `fetch_interventions`.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_heatmap_interventions
"""

import unittest
from importlib import import_module

import frappe
from frappe.utils import add_days, today

H = import_module("upande_scp.serverscripts.dashboard_aggregates._heatmap_interventions")

SCOUT = {
    "2026-W40": {"first": "2026-09-29", "last": "2026-10-02", "entries": 80, "scouts": 3},
    "2026-W41": {"first": "2026-10-06", "last": "2026-10-09", "entries": 70, "scouts": 2},
    "2026-W42": {"first": "2026-10-13", "last": "2026-10-16", "entries": 75, "scouts": 3},
}
WEEKS = list(SCOUT)
FIGS = {
    "2026-W40": {"prevalence": 40.0, "reliability": "Good"},
    "2026-W41": {"prevalence": 12.0, "reliability": "Fair"},
    "2026-W42": {"prevalence": 13.0, "reliability": "Good"},
}


def ev(date, targets=("Thrips",), wo="WO-X"):
    return {"workOrder": wo, "date": date, "chemicals": ["C"], "ingredients": ["a"],
            "moa": [], "targets": list(targets)}


class TestMatching(unittest.TestCase):
    def build(self, events, obs="Thrips"):
        return H.build_intervals(WEEKS, SCOUT, events, FIGS, obs)

    def test_in_range_goes_to_its_interval(self):
        out = self.build([ev("2026-10-04")])
        self.assertEqual([(i["fromWeek"], i["toWeek"]) for i in out], [("2026-W40", "2026-W41")])

    def test_same_day_as_last_scouting_is_before_it_not_between(self):
        self.assertEqual(self.build([ev("2026-10-02")]), [])
        self.assertEqual(len(self.build([ev("2026-10-06")])), 1)  # first day of B counts

    def test_outside_every_gap_is_ignored(self):
        self.assertEqual(self.build([ev("2026-09-20"), ev("2026-10-30")]), [])

    def test_target_must_include_the_pest(self):
        self.assertEqual(self.build([ev("2026-10-04", targets=("Mites",))]), [])
        self.assertEqual(len(self.build([ev("2026-10-04", targets=("thrips", "Mites"))])), 1)

    def test_all_targets_when_pest_filter_is_all(self):
        self.assertEqual(len(self.build([ev("2026-10-04", targets=("Mites",))], obs="")), 1)

    def test_two_sprays_in_one_gap_share_an_interval(self):
        out = self.build([ev("2026-10-03", wo="A"), ev("2026-10-05", wo="B")])
        self.assertEqual([e["workOrder"] for e in out[0]["interventions"]], ["A", "B"])


class TestDelta(unittest.TestCase):
    def test_before_after_and_reliability(self):
        out = H.build_intervals(WEEKS, SCOUT, [ev("2026-10-04")], FIGS, "Thrips")[0]
        self.assertEqual(out["delta"], -28.0)
        self.assertEqual(out["direction"], "better")
        self.assertEqual(out["before"]["reliability"], "Good")
        self.assertEqual(out["after"]["reliability"], "Fair")
        self.assertEqual(out["quality"]["after"], {"entries": 70, "scouts": 2})

    def test_worse_unchanged_unknown(self):
        self.assertEqual(H.delta_between({"prevalence": 10}, {"prevalence": 25.5})["direction"], "worse")
        self.assertEqual(H.delta_between({"prevalence": 10}, {"prevalence": 10.4})["direction"], "unchanged")
        self.assertEqual(H.delta_between({"prevalence": 10}, None)["delta"], None)

    def test_week_accuracy_carries_reliability_and_sample(self):
        acc = H.week_accuracy(WEEKS, FIGS, SCOUT)
        self.assertEqual(acc["2026-W41"]["reliability"], "Fair")
        self.assertEqual(acc["2026-W41"]["entries"], 70)


class TestFetch(unittest.TestCase):
    """Greenhouse link and state/date handling, on a throwaway plan."""

    @classmethod
    def setUpClass(cls):
        from upande_scp.serverscripts.tests import afp_fixture as AF

        cls.fx = AF.ThrowawayPlan("INT")
        try:
            cls.fx.build(transfer=False)
        except Exception:
            frappe.db.rollback()
            AF.wipe(cls.fx.prefix)
            raise
        cls.wo = cls.fx.wo.name

    @classmethod
    def tearDownClass(cls):
        from upande_scp.serverscripts.tests import afp_fixture as AF

        frappe.db.rollback()
        AF.wipe(cls.fx.prefix)

    def _state(self, state, targets="Thrips\nMites"):
        self.fx.assert_owns(self.wo)
        frappe.db.set_value("Work Order", self.wo,
                            {"workflow_state": state, "custom_targets": targets},
                            update_modified=False)

    def fetch(self, gh=None):
        return H.fetch_interventions(gh or self.fx.gh, add_days(today(), -30), add_days(today(), 5))

    def test_completed_plan_is_listed_with_its_targets_and_chemical(self):
        self._state("Completed")
        out = self.fetch()
        self.assertEqual([e["workOrder"] for e in out], [self.wo])
        self.assertEqual(out[0]["targets"], ["Thrips", "Mites"])
        self.assertIn(self.fx.chem, out[0]["chemicals"])

    def test_unmanufactured_plan_is_not_an_intervention(self):
        self._state("Awaiting Approval")
        self.assertEqual(self.fetch(), [])

    def test_other_greenhouse_does_not_match(self):
        self._state("Completed")
        self.assertEqual(self.fetch(gh="_TEST INT NOWHERE"), [])

    def test_date_outside_range_is_excluded(self):
        self._state("Completed")
        self.assertEqual(
            H.fetch_interventions(self.fx.gh, add_days(today(), -400), add_days(today(), -300)), [])
