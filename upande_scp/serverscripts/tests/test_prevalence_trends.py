"""Trends prevalence tables on kaitet.local. DB test — direct runner."""

import unittest

import frappe

from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import prevalence_fixture as PF


class TestTrendsPrevalence(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")

    def tearDown(self):
        crop_scope.clear_cache()
        frappe.db.rollback()

    def _trends(self):
        return DA.trends(from_date=PF.WEEK_10[0], to_date=PF.WEEK_10[1], crop="Rose", force="1")

    def test_station_and_farm_rows_carry_the_house_figures(self):
        out = self._trends()
        v = out["vocab"]
        w, s, o = v["weeks"].index("2031-W10"), v["stations"].index(self.gh), v["obs"].index("pest:Thrips")
        self.assertEqual(v["reliability"], ["Good", "Fair", "Low"])
        self.assertIn([w, s, o, 33.3, 18.0, 1], out["prevalenceByStation"])
        farm = next(f for f, ss in out["stationsByFarm"].items() if self.gh in ss)
        self.assertIn([w, v["farms"].index(farm), o, 33.3, 18.0, 1], out["prevalenceByFarm"])  # Agresti–Coull floor: p̃ = 11/31 (or 20/31) → 1.96·sqrt(0.22893/27) = 18.0 (was 17.8)

    def test_the_incidence_tables_are_unchanged(self):
        out = self._trends()
        v = out["vocab"]
        w, s, o = v["weeks"].index("2031-W10"), v["stations"].index(self.gh), v["obs"].index("pest:Thrips")
        self.assertIn([w, s, 27], out["scoutedByStation"])
        self.assertIn([w, s, o, 9], out["byKindName"])

    def test_avocado_block_rows_are_keyed_by_the_block(self):
        block = F.avocado_block()
        PF.seed_even_week(block, PF.WEEK_10[0], crop="Avocado", pest="Fruit fly (Ceratitis)", block=True)
        out = DA.trends(from_date=PF.WEEK_10[0], to_date=PF.WEEK_10[1], crop="Avocado", force="1")
        v = out["vocab"]
        w, s = v["weeks"].index("2031-W10"), v["stations"].index(block)
        o = v["obs"].index("pest:Fruit fly (Ceratitis)")
        row = next(r for r in out["prevalenceByStation"] if r[:3] == [w, s, o])
        self.assertEqual(row[3], 33.3)
        self.assertTrue(any(r[0] == w and r[2] == o for r in out["prevalenceByFarm"]))


class TestTrendsCleanWeeks(unittest.TestCase):
    """A clean scouted week between two infested weeks is a 0 % row, not a gap."""

    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()
        PF.seed_even_week(self.gh, "2031-03-03", crop="Rose")                           # W10 infested
        PF.seed_even_week(self.gh, "2031-03-10", crop="Rose", infested_per_section=0)   # W11 clean
        PF.seed_even_week(self.gh, "2031-03-17", crop="Rose")                           # W12 infested

    def tearDown(self):
        crop_scope.clear_cache()
        frappe.db.rollback()

    def test_the_clean_week_is_plotted_at_zero(self):
        out = DA.trends(from_date="2031-03-03", to_date="2031-03-23", crop="Rose", force="1")
        v = out["vocab"]
        s, o = v["stations"].index(self.gh), v["obs"].index("pest:Thrips")
        series = {v["weeks"][r[0]]: r[3] for r in out["prevalenceByStation"] if r[1:3] == [s, o]}
        self.assertEqual(series, {"2031-W10": 33.3, "2031-W11": 0.0, "2031-W12": 33.3})
        farm = v["farms"].index(next(f for f, ss in out["stationsByFarm"].items() if self.gh in ss))
        farm_weeks = {v["weeks"][r[0]] for r in out["prevalenceByFarm"] if r[1:3] == [farm, o]}
        self.assertEqual(farm_weeks, {"2031-W10", "2031-W11", "2031-W12"})
        clean = next(r for r in out["prevalenceByStation"] if r[1:3] == [s, o] and v["weeks"][r[0]] == "2031-W11")
        self.assertGreater(clean[4], 0)                  # margin floor: never ±0
