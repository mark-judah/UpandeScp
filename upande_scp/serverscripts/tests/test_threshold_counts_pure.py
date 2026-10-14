"""StationWeeks per-station counts over hand-built rows — plain pytest, no site."""

import unittest
from importlib import import_module

R = import_module("upande_scp.serverscripts.dashboard_aggregates._prevalence_rows")

# 27 stations, 3 in each of the 9 sections (same shape as test_prevalence_rows_pure).
GRID = {f"Z{r}{c}{k}": (r, c) for r in range(3) for c in range(3) for k in range(3)}
FIRSTS = sorted(n for n in GRID if n.endswith("0"))   # first station of each section


def scouted(wh, yw, stations, in_win=1):
    return [{"wh": wh, "station": s, "yw": yw, "in_win": in_win} for s in stations]


def counted(wh, yw, stations, count, stage="Adult", obs="Thrips", kind="pest", section="Leaf"):
    return [{"wh": wh, "station": s, "yw": yw, "kind": kind, "obs": obs, "stage": stage,
             "section": section, "count": count} for s in stations]


def weeks(scouted_rows, infested_rows):
    return R.StationWeeks(scouted_rows, infested_rows, grid_loader=lambda wh: dict(GRID))


class TestStationCounts(unittest.TestCase):
    def test_counts_sum_only_the_named_stages(self):
        w = weeks(scouted("GH A", 203110, GRID),
                  counted("GH A", 203110, ["Z000"], 3, stage="Adult")
                  + counted("GH A", 203110, ["Z000"], 1, stage="Damages")
                  + counted("GH A", 203110, ["Z010"], 2, stage="Larvae"))
        self.assertEqual(
            w.station_counts("GH A", "2031-W10", "pest", "Thrips", frozenset({"Adult", "Larvae"})),
            {"Z000": 3.0, "Z010": 2.0},
        )
        self.assertEqual(w.station_counts("GH A", "2031-W10", "pest", "Thrips"),
                         {"Z000": 4.0, "Z010": 2.0})

    def test_count_latest_reads_the_latest_week_with_the_previous_value(self):
        w = weeks(scouted("GH A", 203109, GRID, in_win=0) + scouted("GH A", 203110, GRID),
                  counted("GH A", 203109, FIRSTS, 6) + counted("GH A", 203110, FIRSTS, 3))
        fig = w.count_latest("GH A", "pest", "Thrips", frozenset({"Adult"}))
        self.assertEqual((fig["week"], fig["value"], fig["prev"]), ("2031-W10", 1.0, 2.0))
        self.assertEqual(fig["sections_scouted"], 9)

    def test_a_house_scouted_clean_counts_zero_with_the_poisson_floor(self):
        w = weeks(scouted("GH A", 203110, GRID), [])
        fig = w.count_latest("GH A", "pest", "Thrips")
        self.assertEqual((fig["value"], fig["margin"]), (0.0, 0.4))

    def test_observations_lists_what_was_recorded_that_week(self):
        w = weeks(scouted("GH A", 203110, GRID),
                  counted("GH A", 203110, ["Z000"], 3)
                  + counted("GH A", 203110, ["Z001"], 1, obs="Aphids")
                  + counted("GH A", 203110, ["Z002"], 0, obs="Botrytis", kind="disease"))
        self.assertEqual(w.observations("GH A", "2031-W10", "pest"), ["Aphids", "Thrips"])
        self.assertEqual(w.observations("GH A", "2031-W10", "disease"), ["Botrytis"])
