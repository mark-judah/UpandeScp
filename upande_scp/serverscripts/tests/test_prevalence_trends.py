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
