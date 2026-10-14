"""Thresholds piece 3a — the pure rules and the count figure. Plain pytest, no site."""

import unittest

from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.common import threshold_bands as B


def grid_of(beds: int, zones: int) -> dict:
    return P.grid_positions(
        {"name": f"B{b}-Z{z}", "group": f"B{b}", "group_no": b, "no": z}
        for b in range(1, beds + 1)
        for z in range(1, zones + 1)
    )


def by_section(grid: dict) -> dict:
    out: dict = {}
    for name, pos in grid.items():
        out.setdefault(pos, []).append(name)
    return {k: sorted(v) for k, v in out.items()}


class TestBands(unittest.TestCase):
    def test_bands_must_rise_strictly_over_the_ones_that_are_set(self):
        self.assertTrue(B.bands_ascending(1, 2, 3))
        self.assertTrue(B.bands_ascending(0, 1, 2))          # Low unset
        self.assertTrue(B.bands_ascending(1, 0, 2))          # Moderate unset
        self.assertTrue(B.bands_ascending(0, 0, 0))          # unconfigured is allowed
        self.assertFalse(B.bands_ascending(1, 0.4, 2))       # Rose Thrips on kaitet.local
        self.assertFalse(B.bands_ascending(5, 5, 10))        # strictly
        self.assertFalse(B.bands_ascending(-1, 2, 3))

    def test_band_of_is_inclusive_and_refuses_unset_or_misordered_bands(self):
        self.assertEqual(B.band_of(2, 0, 1, 2), "high")
        self.assertEqual(B.band_of(1, 0, 1, 2), "moderate")
        self.assertEqual(B.band_of(0.5, 0, 1, 2), "")        # judged, below every band
        self.assertEqual(B.band_of(0.5, 0.5, 1, 2), "low")
        self.assertIsNone(B.band_of(5, 0, 0, 0))
        self.assertIsNone(B.band_of(5, 1, 0.4, 2))
        self.assertIsNone(B.band_of(None, 0, 1, 2))

    def test_action_mapping(self):
        self.assertEqual(B.action_for("moderate", "Low"), "Alarming")
        self.assertEqual(B.action_for("moderate", "Good"), "Alarming")
        self.assertEqual(B.action_for("high", "Good"), "Spray advised")
        self.assertEqual(B.action_for("high", "Fair"), "Spray advised")
        self.assertEqual(B.action_for("high", "Low"), "Scout first")
        self.assertEqual(B.action_for("high", None), "Scout first")
        for band in ("low", "", None):
            self.assertIsNone(B.action_for(band, "Good"))

    def test_escalation(self):
        self.assertTrue(B.escalates(None, "Alarming"))
        self.assertFalse(B.escalates("Alarming", "Alarming"))
        self.assertTrue(B.escalates("Alarming", "Scout first"))
        self.assertTrue(B.escalates("Alarming", "Spray advised"))
        self.assertTrue(B.escalates("Scout first", "Spray advised"))
        self.assertFalse(B.escalates("Spray advised", "Scout first"))
        self.assertFalse(B.escalates("Alarming", None))

    def test_effective_measure(self):
        # A Count row judges its own (all-stage) figure and its counted stages as
        # counts; a tick-box stage under it is a share — a tick is not a count.
        self.assertEqual(B.effective_measure("Count"), "Count")
        self.assertEqual(B.effective_measure("Count", "Count"), "Count")
        self.assertEqual(B.effective_measure("Count", "Checkbox"), "Percentage")
        self.assertEqual(B.effective_measure("Count", "Range"), "Percentage")
        self.assertEqual(B.effective_measure("Percentage", "Count"), "Percentage")
        self.assertEqual(B.effective_measure(None), "Percentage")

    def test_count_is_allowed_only_for_a_pest_with_a_counted_stage(self):
        self.assertTrue(B.count_allowed("pest", ["Count", "Checkbox"]))
        self.assertFalse(B.count_allowed("pest", ["Checkbox"]))
        self.assertFalse(B.count_allowed("pest", []))
        self.assertFalse(B.count_allowed("disease", ["Count"]))

    def test_unit_labels(self):
        self.assertEqual(B.unit_label("Percentage", "tree"), "%")
        self.assertEqual(B.unit_label("Count", "tree"), "per tree")
        self.assertEqual(B.unit_label("Count"), "per zone")
        self.assertEqual(B.format_value(33.3, "%"), "33.3%")
        self.assertEqual(B.format_value(1.2, "per zone"), "1.2 per zone")
        self.assertEqual(B.format_value(None, "%"), "—")


class TestCountFigures(unittest.TestCase):
    def test_even_sections_average_the_section_averages_with_a_hand_worked_margin(self):
        grid = grid_of(9, 3)                       # 27 stations, 3 per section
        sections = by_section(grid)
        per = [1, 1, 1, 2, 2, 2, 3, 3, 3]          # a_j, row-major
        counts = {}
        for j, pos in enumerate(sorted(sections)):
            for st in sections[pos]:
                counts[st] = per[j]
        fig = P.count_figures(grid, set(grid), counts)
        # mean(a_j) = 2.0; s² = 6/8 = 0.75; v = max(2, 1) = 2; N = 27
        # margin = 1.96·sqrt(0.75/9 + 2/27) = 1.96·0.39675 = 0.7776 → 0.8
        self.assertEqual((fig["value"], fig["margin"], fig["sections_scouted"]), (2.0, 0.8, 9))
        self.assertIsNone(fig["prevalence"])
        self.assertIsNone(fig["reason"])
        self.assertEqual(fig["reliability"], "Fair")   # 0.78 / 2 = 0.39 > 0.10
        self.assertEqual([s["avg"] for s in fig["sections"]], [1.0, 1.0, 1.0, 2.0, 2.0, 2.0, 3.0, 3.0, 3.0])

    def test_an_all_zero_sample_never_reads_plus_minus_zero(self):
        grid = grid_of(9, 3)
        fig = P.count_figures(grid, set(grid), {})
        # Poisson floor: v = max(0, 1) = 1 → 1.96·sqrt(1/27) = 0.377 → 0.4
        self.assertEqual((fig["value"], fig["margin"]), (0.0, 0.4))

    def test_one_counted_section_is_too_clustered_to_judge(self):
        grid = grid_of(9, 3)
        sections = by_section(grid)
        scouted = set(sections[(0, 0)]) | {sections[(1, 1)][0], sections[(2, 2)][0]}
        fig = P.count_figures(grid, scouted, {sections[(0, 0)][0]: 6})
        self.assertEqual((fig["value"], fig["sections_scouted"]), (2.0, 1))
        self.assertIsNone(fig["margin"])
        self.assertEqual((fig["reason"], fig["reliability"]), ("too clustered to judge", "Low"))

    def test_no_counted_section_falls_back_to_the_raw_average(self):
        grid = grid_of(9, 3)
        sections = by_section(grid)
        a, b = sections[(0, 0)][0], sections[(2, 2)][0]
        fig = P.count_figures(grid, {a, b}, {a: 4, b: 2})
        self.assertEqual((fig["value"], fig["raw"], fig["sections_scouted"]), (3.0, 3.0, 0))
        self.assertIsNone(fig["margin"])
        self.assertEqual(fig["reliability"], "Low")

    def test_good_needs_a_tight_margin_relative_to_the_figure(self):
        grid = grid_of(9, 9)                       # 81 stations, 9 per section
        fig = P.count_figures(grid, set(grid), {st: 10 for st in grid})
        # 1.96·sqrt(0 + 10/81) = 0.689 → 0.7; 0.689 / 10 = 0.069 ≤ 0.10, m = 9 ≥ 7
        self.assertEqual((fig["value"], fig["margin"], fig["reliability"]), (10.0, 0.7, "Good"))

    def test_counts_outside_the_scouted_set_are_ignored_and_nothing_scouted_is_none(self):
        grid = grid_of(9, 3)
        self.assertIsNone(P.count_figures(grid, set(), {"B1-Z1": 5}))
        fig = P.count_figures(grid, set(grid), {"not-a-station": 99})
        self.assertEqual(fig["value"], 0.0)

    def test_a_house_with_no_stations_has_no_value(self):
        fig = P.count_figures({}, {"a"}, {"a": 4})
        self.assertIsNone(fig["value"])
        self.assertEqual((fig["reason"], fig["raw"]), ("no stations set up", 4.0))
