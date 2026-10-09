"""Pests / Diseases tabs on station prevalence. DB test — direct runner."""

import unittest

import frappe

from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import prevalence_fixture as PF


class TestPestsPrevalence(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh, self.other = PF.rose_greenhouses(2)

    def tearDown(self):
        crop_scope.clear_cache()
        frappe.db.rollback()

    def _pests(self, **kw):
        return DA.pests(from_date=PF.WEEK_10[0], to_date=PF.WEEK_10[1], crop="Rose", force="1", **kw)

    def test_ranking_carries_the_scope_wide_figure(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")
        row = next(r for r in self._pests()["ranking"] if r["name"] == "Thrips")
        self.assertEqual((row["prevalence"], row["sections_scouted"], row["reliability"]), (33.3, 9, "Fair"))
        self.assertEqual(row["margin"], 17.8)
        self.assertIsNone(row["prev"])

    def test_pressure_and_distribution_read_the_latest_week(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")
        out = self._pests()
        gh_row = next(r for r in out["greenhousePressure"] if r["name"] == self.gh)
        self.assertEqual((gh_row["pct"], gh_row["zones"], gh_row["margin"]), (33.3, 9, 17.8))
        dist = next(r for r in out["distribution"] if r["name"] == "Thrips")
        self.assertEqual((dist["pct"], dist["zones"]), (33.3, 9))

    def test_the_trend_is_a_weekly_series(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")
        out = self._pests(observation="Thrips")
        self.assertEqual(out["dailyPercent"], [
            {"date": "2031-03-03", "week": "2031-W10", "value": 33.3, "margin": 17.8, "reliability": "Fair"},
        ])

    def test_the_stage_filter_narrows_the_infested_stations(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")       # every hit is stage Adult
        out = self._pests(observation="Thrips", stage="Larvae")
        gh_row = next(r for r in out["greenhousePressure"] if r["name"] == self.gh)
        self.assertEqual(gh_row["pct"], 0.0)

    def test_a_house_scouted_clean_counts_in_the_scope_wide_figure(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")
        PF.seed_even_week(self.other, PF.WEEK_10[0], crop="Rose", infested_per_section=0)
        a = frappe.db.count("Zone", {"greenhouse": self.gh})
        b = frappe.db.count("Zone", {"greenhouse": self.other})
        dist = next(r for r in self._pests()["distribution"] if r["name"] == "Thrips")
        self.assertEqual(dist["pct"], round((a * 33.3 + b * 0.0) / (a + b), 1))
        pressure = {r["name"]: r["pct"] for r in self._pests()["greenhousePressure"]}
        self.assertEqual(pressure[self.other], 0.0)

    def test_diseases_read_the_same_measure(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose", pest=None, disease="Powdery Mildew")
        out = DA.diseases(from_date=PF.WEEK_10[0], to_date=PF.WEEK_10[1], crop="Rose", force="1")
        row = next(r for r in out["ranking"] if r["name"] == "Powdery Mildew")
        self.assertEqual((row["prevalence"], row["reliability"]), (33.3, "Fair"))
        gh_row = next(r for r in out["greenhousePressure"] if r["name"] == self.gh)
        self.assertEqual(gh_row["pct"], 33.3)

    def test_avocado_blocks_read_tree_stations(self):
        block = F.avocado_block()
        PF.seed_even_week(block, PF.WEEK_10[0], crop="Avocado", pest="Fruit fly (Ceratitis)", block=True)
        out = DA.pests(from_date=PF.WEEK_10[0], to_date=PF.WEEK_10[1], crop="Avocado", force="1")
        row = next(r for r in out["greenhousePressure"] if r["name"] == block)
        self.assertEqual(row["pct"], 33.3)
        self.assertEqual(row["stations"], frappe.db.count("Orchard Tree", {"block": block}))
