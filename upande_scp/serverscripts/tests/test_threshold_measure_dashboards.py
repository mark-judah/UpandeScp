"""The row's measure drives dashboard severity. DB test — direct runner."""

import unittest
from importlib import import_module

import frappe

from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import thresholds_fixture as TF

O = import_module("upande_scp.serverscripts.dashboard_aggregates._overview")


class TestMeasureOnDashboards(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()
        TF.clear_all_bands("Rose")

    def tearDown(self):
        frappe.set_user("Administrator")
        _common.clear_threshold_cache()
        frappe.db.rollback()

    def _cell(self, stage):
        where, params = _common.parent_filter_conditions(TF.WEEK_20[0], TF.WEEK_20[1], "Rose", None)
        weeks = R.StationWeeks.load(TF.WEEK_20[0], TF.WEEK_20[1], "Rose", None)
        cells = O._classify_cells(O._observation_rows(where, params), "Rose", weeks)[1]
        return next(c for c in cells
                    if c["greenhouse"] == self.gh and c["obs_name"] == "Thrips" and c["stage"] == stage)

    def test_a_count_row_judges_the_average_count_not_the_share(self):
        TF.set_bands("Rose", "Thrips", 0, 1, 2, measure="Count")
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose", stage="Adult", count=3)
        cell = self._cell("Adult")
        self.assertEqual(cell["prevalence"], 33.3)
        # 1 of 3 stations per section, 3 each → 1.0 per zone: Moderate. Read as a
        # percentage, 33.3 would have been High.
        self.assertEqual(cell["severity"], "moderate")

    def test_a_percentage_row_still_judges_the_share(self):
        TF.set_bands("Rose", "Thrips", 0, 10, 30)
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose", stage="Adult", count=3)
        self.assertEqual(self._cell("Adult")["severity"], "high")

    def test_a_tick_box_stage_under_a_count_row_is_judged_as_a_share(self):
        TF.set_bands("Rose", "Thrips", 0, 1, 2, measure="Count")
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose", stage="Damages", count=1)
        self.assertEqual(_common.band_spec("Rose", "pest", "Thrips", "Damages")["measure"], "Percentage")
        self.assertEqual(self._cell("Damages")["severity"], "high")      # 33.3 % ≥ 2

    def test_the_row_count_sums_only_counted_stages(self):
        TF.set_bands("Rose", "Thrips", 0, 1, 2, measure="Count")
        spec = _common.band_spec("Rose", "pest", "Thrips", "")
        self.assertEqual((spec["measure"], spec["count_stages"]), ("Count", frozenset({"Adult", "Larvae"})))
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose", stage="Adult", count=3)
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose", stage="Damages", count=1)
        weeks = R.StationWeeks.load(TF.WEEK_20[0], TF.WEEK_20[1], "Rose", None)
        self.assertEqual(weeks.count_latest(self.gh, "pest", "Thrips", stages=spec["count_stages"])["value"], 1.0)

    def test_misordered_bands_classify_nothing(self):
        TF.set_bands("Rose", "Thrips", 1, 0.4, 2)
        self.assertIsNone(_common.band_spec("Rose", "pest", "Thrips", ""))
        self.assertIsNone(_common.severity_for("Rose", "pest", "Thrips", "", 50.0))

    def test_a_stage_band_wins_over_the_row_band(self):
        TF.set_bands("Rose", "Thrips", 0, 50, 90, stage_bands={"Adult": (0, 10, 30)})
        self.assertEqual(_common.severity_for("Rose", "pest", "Thrips", "Adult", 33.3), "high")
        self.assertEqual(_common.severity_for("Rose", "pest", "Thrips", "Larvae", 33.3), None)
        self.assertIsNone(_common.severity_for("Rose", "pest", "Thrips", "Adult", None))
