"""StationWeeks over hand-built rows — runs under plain pytest, no site."""

import unittest
from importlib import import_module
from unittest.mock import patch

R = import_module("upande_scp.serverscripts.dashboard_aggregates._prevalence_rows")

# 27 stations, 3 in each of the 9 sections.
GRID = {f"Z{r}{c}{k}": (r, c) for r in range(3) for c in range(3) for k in range(3)}
EVEN = sorted(n for n in GRID if n.endswith("0") or n.endswith("1") or n.endswith("2"))


def scouted(wh, yw, stations, in_win=1):
    return [{"wh": wh, "station": s, "yw": yw, "in_win": in_win} for s in stations]


def infested(wh, yw, stations, obs="Thrips", stage="Adult", section="Leaf", kind="pest"):
    return [{"wh": wh, "station": s, "yw": yw, "kind": kind, "obs": obs,
             "stage": stage, "section": section} for s in stations]


def first_of_each_section(k=1):
    return [n for n in GRID if int(n[-1]) < k]


def weeks(scouted_rows, infested_rows):
    return R.StationWeeks(scouted_rows, infested_rows, grid_loader=lambda wh: dict(GRID))


class TestStationWeeks(unittest.TestCase):
    def test_latest_week_and_the_previous_scouted_week(self):
        w = weeks(
            scouted("GH A", 203109, EVEN, in_win=0) + scouted("GH A", 203110, EVEN),
            infested("GH A", 203109, first_of_each_section(2)) + infested("GH A", 203110, first_of_each_section(1)),
        )
        self.assertEqual(w.latest_pair("GH A"), ("2031-W10", "2031-W09"))
        fig = w.latest("GH A", "pest", "Thrips")
        self.assertEqual((fig["week"], fig["prevalence"], fig["prev"]), ("2031-W10", 33.3, 66.7))

    def test_only_one_week_has_no_previous(self):
        w = weeks(scouted("GH A", 203110, EVEN), infested("GH A", 203110, first_of_each_section(1)))
        self.assertIsNone(w.latest("GH A", "pest", "Thrips")["prev"])

    def test_a_house_not_scouted_that_week_is_omitted(self):
        w = weeks(
            scouted("GH A", 203110, EVEN) + scouted("GH B", 203109, EVEN, in_win=0),
            infested("GH B", 203109, first_of_each_section(1)),
        )
        self.assertEqual(w.warehouses(), ["GH A"])                    # B only has lookback weeks
        self.assertEqual(w.warehouses_in("2031-W10"), ["GH A"])
        self.assertIsNone(w.figures("GH A", "2031-W11", "pest", "Thrips"))
        self.assertIsNone(w.latest("GH B", "pest", "Thrips"))

    def test_a_clean_scouted_house_reads_zero_not_absent(self):
        w = weeks(scouted("GH A", 203110, EVEN), [])
        self.assertEqual(w.latest("GH A", "pest", "Thrips")["prevalence"], 0.0)

    def test_stage_and_section_filters_narrow_the_infested_set(self):
        rows = (infested("GH A", 203110, ["Z000"], stage="Adult", section="Leaf")
                + infested("GH A", 203110, ["Z010"], stage="Larvae", section="Stem")
                + infested("GH A", 203110, ["Z020"], obs="Aphids"))
        w = weeks(scouted("GH A", 203110, EVEN), rows)
        self.assertEqual(w.infested_set("GH A", "2031-W10", "pest", "Thrips"), {"Z000", "Z010"})
        self.assertEqual(w.infested_set("GH A", "2031-W10", "pest", "Thrips", stage="Larvae"), {"Z010"})
        self.assertEqual(w.infested_set("GH A", "2031-W10", "pest", section="Leaf"), {"Z000", "Z020"})
        self.assertEqual(w.infested_set("GH A", "2031-W10", "pest"), {"Z000", "Z010", "Z020"})
        self.assertEqual(w.infested_set("GH A", "2031-W10", "disease"), set())

    def test_the_grid_loader_is_looked_up_when_called(self):
        # The regression suites patch _prevalence_rows.station_grid; that only works
        # if StationWeeks resolves it at call time, not at definition time.
        w = R.StationWeeks(scouted("GH A", 203110, EVEN), [])
        with patch.object(R, "station_grid", return_value=dict(GRID)) as loader:
            self.assertEqual(w.latest("GH A", "pest", "Thrips")["stations"], 27)
        loader.assert_called_once_with("GH A")

    def test_combined_latest_weights_the_houses(self):
        w = weeks(
            scouted("GH A", 203110, EVEN) + scouted("GH B", 203110, EVEN),
            infested("GH A", 203110, first_of_each_section(1)),
        )
        out = w.combined_latest("pest", "Thrips")
        # Equal-sized houses at 33.3% and 0%: (27·33.3 + 27·0) / 54, rounded the way combine does.
        self.assertEqual((out["prevalence"], out["houses"], out["prev"]), (round(27 * 33.3 / 54, 1), 2, None))

    def test_year_boundary_weeks_order_correctly(self):
        w = weeks(scouted("GH A", 203253, EVEN, in_win=0) + scouted("GH A", 203301, EVEN), [])
        self.assertEqual(w.latest_pair("GH A"), ("2033-W01", "2032-W53"))
        self.assertEqual(w.window_weeks(), ["2033-W01"])

    def test_rows_without_a_station_are_ignored(self):
        w = weeks([{"wh": "GH A", "station": "", "yw": 203110, "in_win": 1}], [])
        self.assertEqual(w.warehouses(), [])


class TestHelpers(unittest.TestCase):
    def test_combined_is_the_scope_wide_figure_for_one_week(self):
        w = weeks(
            scouted("GH A", 203110, EVEN) + scouted("GH B", 203110, EVEN) + scouted("GH A", 203111, EVEN),
            infested("GH A", 203110, first_of_each_section(1)),
        )
        out = w.combined("2031-W10", "pest", "Thrips")
        self.assertEqual((out["prevalence"], out["houses"]), (round(27 * 33.3 / 54, 1), 2))
        self.assertEqual(w.combined("2031-W11", "pest", "Thrips")["houses"], 1)
        self.assertIsNone(w.combined("2031-W12", "pest", "Thrips"))

    def test_latest_by_house_lists_each_observation_with_its_previous(self):
        w = weeks(
            scouted("GH A", 203109, EVEN, in_win=0) + scouted("GH A", 203110, EVEN) + scouted("GH B", 203110, EVEN),
            infested("GH A", 203109, first_of_each_section(2), obs="Aphids")
            + infested("GH A", 203110, first_of_each_section(1)),
        )
        out = w.latest_by_house("pest")
        self.assertEqual(sorted(out), ["GH A", "GH B"])
        self.assertEqual(sorted(out["GH A"]), ["Aphids", "Thrips"])
        self.assertEqual((out["GH A"]["Aphids"]["prevalence"], out["GH A"]["Aphids"]["prev"]), (0.0, 66.7))
        self.assertEqual(out["GH A"]["Thrips"]["week"], "2031-W10")
        self.assertEqual(out["GH B"], {})
        self.assertEqual(w.latest_by_house("disease")["GH A"], {})

    def test_a_house_with_no_stations_is_kept_with_a_reason(self):
        w = R.StationWeeks(scouted("GH A", 203110, EVEN), infested("GH A", 203110, ["Z000"]),
                           grid_loader=lambda wh: {})
        fig = w.latest("GH A", "pest", "Thrips")
        self.assertEqual((fig["prevalence"], fig["reliability"], fig["reason"], fig["stations"]),
                         (None, "Low", "no stations set up", 0))
        self.assertEqual(w.warehouses(), ["GH A"])
        self.assertEqual(w.latest_by_house("pest")["GH A"]["Thrips"]["reason"], "no stations set up")
        self.assertIsNone(w.combined("2031-W10", "pest", "Thrips"))
