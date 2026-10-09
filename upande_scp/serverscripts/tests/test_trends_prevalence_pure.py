"""Trends prevalence tables — pure; the farms map and the week sets are faked."""

import unittest
from importlib import import_module
from unittest.mock import patch

_trends = import_module("upande_scp.serverscripts.dashboard_aggregates._trends")

FARMS = {"Karen Farm": ["GH 12", "GH 13"]}
PAYLOAD = {
    "vocab": {"weeks": ["2031-W10"], "stations": ["GH 12", "GH 13"],
              "obs": ["pest:Thrips"], "stages": [""]},
    "byKindName": [[0, 0, 0, 3]],
}


def fig(stations, prevalence, margin, reliability, infested=1):
    return {"stations": stations, "scouted": 10, "infested": infested, "coverage": 10.0,
            "raw": 10.0, "prevalence": prevalence, "margin": margin, "sections_scouted": 9,
            "sections_total": 9, "reliability": reliability, "reason": None, "sections": []}


class FakeWeeks:
    def __init__(self, figs):
        self.figs = figs  # (station, week, kind, obs) -> figures

    def figures(self, wh, week, kind, obs=None, stage=None, section=None):
        return self.figs.get((wh, week, kind, obs))

    def warehouses_in(self, week):
        return sorted({k[0] for k in self.figs if k[1] == week})

    def weeks(self, wh):
        return sorted({k[1] for k in self.figs if k[0] == wh})


def tables(figs, payload=PAYLOAD):
    with patch.object(_trends.scouting_metrics, "get_farms_and_warehouses", return_value=FARMS):
        return _trends._prevalence_tables(payload, FakeWeeks(figs))


FIGS = {
    ("GH 12", "2031-W10", "pest", "Thrips"): fig(100, 30.0, 5.0, "Fair"),
    ("GH 13", "2031-W10", "pest", "Thrips"): fig(300, 0.0, 2.0, "Good", infested=0),
}


class TestPrevalenceTables(unittest.TestCase):
    def test_station_rows_follow_the_observation_table(self):
        self.assertEqual(tables(FIGS)["prevalenceByStation"], [[0, 0, 0, 30.0, 5.0, 1]])

    def test_farm_rows_weight_every_scouted_house_clean_ones_included(self):
        out = tables(FIGS)
        self.assertEqual(out["vocab"]["farms"], ["Karen Farm"])
        # (100·30 + 300·0) / 400 = 7.5; sqrt((100·5)² + (300·2)²) / 400 = 1.95 → 2.0; worst = Fair
        self.assertEqual(out["prevalenceByFarm"], [[0, 0, 0, 7.5, 2.0, 1]])

    def test_reliability_vocab_is_published_and_the_rest_kept(self):
        out = tables(FIGS)
        self.assertEqual(out["vocab"]["reliability"], ["Good", "Fair", "Low"])
        self.assertEqual(out["vocab"]["stations"], ["GH 12", "GH 13"])

    def test_a_too_clustered_house_leaves_the_margin_unknown(self):
        figs = dict(FIGS)
        figs[("GH 12", "2031-W10", "pest", "Thrips")] = fig(100, 30.0, None, "Low")
        out = tables(figs)
        self.assertEqual(out["prevalenceByStation"], [[0, 0, 0, 30.0, None, 2]])
        self.assertIsNone(out["prevalenceByFarm"][0][4])

    def test_a_house_without_stations_writes_no_row(self):
        figs = {("GH 12", "2031-W10", "pest", "Thrips"): dict(fig(0, None, None, "Low"), stations=0)}
        out = tables(figs)
        self.assertEqual((out["prevalenceByStation"], out["prevalenceByFarm"]), ([], []))


class TestCleanScoutedWeeks(unittest.TestCase):
    """Band mode plots every week a house/farm was scouted for an observation
    seen there in the window: a clean scouted week is 0 %, not a bridged gap."""

    PAYLOAD = {
        "vocab": {"weeks": ["2031-W10", "2031-W11", "2031-W12", "2031-W13"],
                  "stations": ["GH 12", "GH 13"], "obs": ["pest:Thrips"], "stages": [""]},
        # Thrips seen at GH 12 in W10 and W12 only; W11 scouted clean; W13 unscouted.
        "byKindName": [[0, 0, 0, 3], [2, 0, 0, 2]],
    }
    FIGS = {
        ("GH 12", "2031-W10", "pest", "Thrips"): fig(100, 30.0, 5.0, "Fair"),
        ("GH 12", "2031-W11", "pest", "Thrips"): fig(100, 0.0, 4.0, "Good", infested=0),
        ("GH 12", "2031-W12", "pest", "Thrips"): fig(100, 20.0, 5.0, "Fair"),
        ("GH 13", "2031-W11", "pest", "Thrips"): fig(300, 0.0, 2.0, "Good", infested=0),
    }

    def test_a_clean_scouted_week_between_infested_weeks_is_a_zero_row(self):
        out = tables(self.FIGS, self.PAYLOAD)
        self.assertEqual(out["prevalenceByStation"], [
            [0, 0, 0, 30.0, 5.0, 1],
            [1, 0, 0, 0.0, 4.0, 0],      # clean, scouted → 0 %, not a gap
            [2, 0, 0, 20.0, 5.0, 1],
        ])                               # W13 unscouted → no row; GH 13 never saw Thrips → none

    def test_the_farm_line_covers_every_week_the_farm_was_scouted(self):
        out = tables(self.FIGS, self.PAYLOAD)
        # W11: (100·0 + 300·0)/400 = 0; sqrt((100·4)² + (300·2)²)/400 = 721.1/400 = 1.8; worst = Good
        self.assertEqual(out["prevalenceByFarm"], [
            [0, 0, 0, 30.0, 5.0, 1],
            [1, 0, 0, 0.0, 1.8, 0],
            [2, 0, 0, 20.0, 5.0, 1],
        ])
