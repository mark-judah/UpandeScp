"""Overview + greenhouse detail on station prevalence. DB test — direct runner."""

import unittest
from importlib import import_module
from unittest.mock import patch

import frappe

from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import prevalence_fixture as PF

O = import_module("upande_scp.serverscripts.dashboard_aggregates._overview")
G = import_module("upande_scp.serverscripts.dashboard_aggregates._gh_detail")
AVOCADO_PEST = "Fruit fly (Ceratitis)"


class TestOverviewPrevalence(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()

    def tearDown(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        frappe.db.rollback()

    def _cells(self, from_date, to_date, crop):
        where, params = _common.parent_filter_conditions(from_date, to_date, crop, None)
        weeks = R.StationWeeks.load(from_date, to_date, crop, None)
        return O._classify_cells(O._observation_rows(where, params), crop, weeks)[1]

    def _seed_two_weeks(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")                          # 9 of 27
        PF.seed_even_week(self.gh, PF.WEEK_11[0], crop="Rose", infested_per_section=2)   # 18 of 27

    def test_a_cell_reads_the_latest_week_with_the_previous_beside_it(self):
        self._seed_two_weeks()
        cell = next(c for c in self._cells(PF.WEEK_10[0], PF.WEEK_11[1], "Rose")
                    if c["greenhouse"] == self.gh and c["obs_name"] == "Thrips" and c["stage"] == "Adult")
        self.assertEqual((cell["prevalence"], cell["prev"], cell["pct"]), (66.7, 33.3, 66.7))
        self.assertEqual((cell["zones"], cell["total"], cell["week"]), (18, 27, "2031-W11"))
        self.assertEqual((cell["sections_scouted"], cell["margin"], cell["reliability"]), (9, 18.0, "Fair"))  # Agresti–Coull floor: p̃ = 11/31 (or 20/31) → 1.96·sqrt(0.22893/27) = 18.0 (was 17.8)

    def test_alerts_carry_the_figures(self):
        self._seed_two_weeks()
        with patch.object(_common, "severity_for", return_value="high"):
            out = DA.overview(from_date=PF.WEEK_10[0], to_date=PF.WEEK_11[1], crop="Rose", force="1")
        alert = next(a for a in out["activeAlerts"] if a["greenhouse"] == self.gh and a["name"] == "Thrips")
        self.assertEqual((alert["prevalence"], alert["prev"], alert["reliability"]), (66.7, 33.3, "Fair"))
        self.assertEqual((alert["sections_scouted"], alert["sections_total"]), (9, 9))
        self.assertEqual(alert["zone"], "18/27 scouted · 2031-W11")
        self.assertEqual(out["kpis"]["highAlerts"], 1)

    def test_avocado_trees_now_make_cells(self):
        block = F.avocado_block()
        PF.seed_even_week(block, PF.WEEK_10[0], crop="Avocado", pest=AVOCADO_PEST, block=True)
        cell = next(c for c in self._cells(PF.WEEK_10[0], PF.WEEK_10[1], "Avocado") if c["greenhouse"] == block)
        self.assertEqual(cell["prevalence"], 33.3)
        self.assertEqual(cell["stations"], frappe.db.count("Orchard Tree", {"block": block}))

    def test_house_without_stations_stays_visible_with_null_figures(self):
        self._seed_two_weeks()
        with patch.object(R, "station_grid", return_value={}):
            cells = self._cells(PF.WEEK_10[0], PF.WEEK_11[1], "Rose")
        cell = next(c for c in cells if c["greenhouse"] == self.gh and c["obs_name"] == "Thrips")
        self.assertIsNone(cell["prevalence"])
        self.assertIsNone(cell["severity"])
        self.assertEqual(cell["reason"], "no stations set up")

    def test_aggregate_keys_carry_the_hot2_schema(self):
        self.assertEqual(_common.K_DASH_AGG_SCHEMA, "hot2")
        self.assertIn(":hot2:overview:", _common._build_key("overview", {"crop": "Rose"}))


class TestGreenhouseDetailPrevalence(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()

    def tearDown(self):
        crop_scope.clear_cache()
        frappe.db.rollback()

    def test_the_top_observations_map_onto_the_3x3_grid(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose", disease="Powdery Mildew")
        out = DA.greenhouse_detail(greenhouse=self.gh, from_date=PF.WEEK_10[0], to_date=PF.WEEK_10[1],
                                   crop="Rose", force="1")
        thrips = next(p for p in out["prevalence"] if p["name"] == "Thrips")
        self.assertEqual(thrips["kind"], "pest")
        self.assertEqual([(s["row"], s["col"]) for s in thrips["sections"]],
                         [(r, c) for r in range(3) for c in range(3)])
        self.assertEqual([s["pct"] for s in thrips["sections"]], [33.3] * 9)
        self.assertEqual((thrips["prevalence"], thrips["sections_scouted"]), (33.3, 9))
        self.assertIn("Powdery Mildew", {p["name"] for p in out["prevalence"] if p["kind"] == "disease"})

    def test_alerts_use_the_latest_week(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")
        PF.seed_even_week(self.gh, PF.WEEK_11[0], crop="Rose", infested_per_section=2)
        high_at_50 = lambda crop, kind, obs, stage, pct: "high" if pct >= 50 else None  # noqa: E731
        with patch.object(G, "severity_for", side_effect=high_at_50):
            both = DA.greenhouse_detail(greenhouse=self.gh, from_date=PF.WEEK_10[0],
                                        to_date=PF.WEEK_11[1], crop="Rose", force="1")
            first = DA.greenhouse_detail(greenhouse=self.gh, from_date=PF.WEEK_10[0],
                                         to_date=PF.WEEK_10[1], crop="Rose", force="1")
        self.assertEqual(both["alerts"], 1)    # W11: 66.7%
        self.assertEqual(first["alerts"], 0)   # W10: 33.3%

    def test_avocado_block_returns_grid_sections(self):
        block = F.avocado_block()
        PF.seed_even_week(block, PF.WEEK_10[0], crop="Avocado", pest=AVOCADO_PEST, block=True)
        out = DA.greenhouse_detail(greenhouse=block, from_date=PF.WEEK_10[0], to_date=PF.WEEK_10[1],
                                   crop="Avocado", force="1")
        fly = next(p for p in out["prevalence"] if p["name"] == AVOCADO_PEST)
        self.assertEqual(len(fly["sections"]), 9)
        self.assertEqual(fly["prevalence"], 33.3)
