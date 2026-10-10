"""Data quality rules (roadmap item 7) — runs under plain pytest, no site."""

import unittest
from datetime import date

from upande_scp.serverscripts.common import quality_rules as Q

D1 = date(2031, 9, 29)
D2 = date(2031, 9, 30)


def row(scout="S1", day=D1, wh="GH1", station="Z1", bed="B1", tm=0, delay=None,
        dist=None, buf=None, nothing=0):
    return (scout, day, wh, station, bed, tm, delay, dist, buf, nothing)


class TestTimes(unittest.TestCase):
    def test_too_fast_counts_only_zone_to_zone_moves_under_five_seconds(self):
        # time order: Z1@0, Z1@2 (same zone — not a move), Z2@4 (move, 2 s: fast),
        # Z3@9 (move, 5 s: not fast), Z3@10 (same zone), Z4@12 (move, 2 s: fast)
        entries = [(10, "Z3"), (0, "Z1"), (12, "Z4"), (4, "Z2"), (2, "Z1"), (9, "Z3")]
        self.assertEqual(Q.too_fast_moves(entries), (2, 3))
        self.assertEqual(Q.too_fast_share(entries), 66.7)

    def test_same_zone_observations_are_never_too_fast(self):
        self.assertEqual(Q.too_fast_moves([(0, "Z1"), (1, "Z1"), (2, "Z1")]), (0, 0))
        self.assertIsNone(Q.too_fast_share([(0, "Z1"), (1, "Z1")]))

    def test_too_fast_skips_missing_times_and_stations(self):
        self.assertEqual(Q.too_fast_moves([(None, "Z1"), (0, "Z1"), (1, ""), (3, "Z2")]), (1, 1))
        self.assertIsNone(Q.too_fast_share([]))

    def test_active_hours_is_first_to_last_capture(self):
        self.assertEqual(Q.active_hours([3600, 7200 + 1800, None, 5000]), 1.5)
        self.assertEqual(Q.active_hours([100]), 0.0)
        self.assertEqual(Q.active_hours([]), 0.0)

    def test_percentile_reads_a_histogram(self):
        hist = {1.0: 5, 2.0: 4, 30.0: 1}
        self.assertEqual(Q.percentile(hist, 0.5), 1.0)
        self.assertEqual(Q.percentile(hist, 0.9), 2.0)
        self.assertEqual(Q.percentile({1.0: 1, 3.0: 1}, 0.5), 1.0)
        self.assertIsNone(Q.percentile({}, 0.5))


class TestFold(unittest.TestCase):
    def fold(self, rows):
        f = Q.Fold()
        f.add_day(rows)
        return f

    def test_scout_figures(self):
        rows = [
            row(tm=0, station="Z1", bed="B1", nothing=1, dist=1, buf=3, delay=60),
            row(tm=0, station="Z1", bed="B1", nothing=0, dist=10, buf=3, delay=180),   # double-submit
            row(tm=2, station="Z1", bed="B1", nothing=1, delay=120),                   # same zone: not a move
            row(tm=4, station="Z2", bed="B2", nothing=0),                              # move in 2 s: fast
            row(tm=3600, station="Z3", bed="B2", nothing=0),                           # move
        ]
        f = self.fold(rows)
        s = f.scout_rows({"S1": "Sam"})[0]
        self.assertEqual((s["scout"], s["scoutName"], s["entries"], s["activeDays"]), ("S1", "Sam", 5, 1))
        self.assertEqual(s["entriesPerHour"], 5.0)
        self.assertEqual(s["bedsPerDay"], 2.0)
        self.assertEqual((s["moves"], s["tooFastPct"]), (2, 50.0))
        self.assertEqual(s["nothingFoundPct"], 40.0)
        self.assertEqual((s["fixes"], s["offZonePct"], s["metadataPct"]), (2, 50.0, 40.0))
        self.assertEqual((s["duplicates"], s["duplicatePct"]), (1, 20.0))
        self.assertEqual(s["medianSyncMin"], 2.0)

    def test_same_zone_same_day_at_different_seconds_is_not_a_duplicate(self):
        s = self.fold([row(tm=0), row(tm=1), row(tm=30)]).scout_rows({})[0]
        self.assertEqual(s["duplicates"], 0)

    def test_scout_baseline_is_the_off_zone_share_of_their_houses_weighted_by_their_fixes(self):
        rows = [row(scout="A", wh="H1", station=f"a{i}", tm=i * 10, dist=9, buf=1) for i in range(4)]  # H1 4/4 off
        rows += [row(scout="B", wh="H1", station=f"b{i}", tm=i * 10, dist=0, buf=1) for i in range(4)]  # H1 → 50%
        rows += [row(scout="A", wh="H2", station=f"c{i}", tm=500 + i * 10, dist=0, buf=1) for i in range(12)]  # H2 0%
        rows += [row(scout="C", wh="H2", station=f"d{i}", tm=i * 10, dist=9, buf=1) for i in range(4)]  # H2 others 100%
        by = {r["scout"]: r for r in self.fold(rows).scout_rows({})}
        # A's baseline leaves A out: H1 others (B) 0% × 4 fixes, H2 others (C) 100% × 12 → 75%
        self.assertEqual((by["A"]["offZonePct"], by["A"]["houseOffZonePct"]), (25.0, 75.0))
        # B: H1 others (A) 100% off
        self.assertEqual(by["B"]["houseOffZonePct"], 100.0)

    def test_a_scout_alone_in_their_houses_has_no_baseline(self):
        s = self.fold([row(dist=9, buf=1)]).scout_rows({})[0]
        self.assertIsNone(s["houseOffZonePct"])

    def test_a_missing_or_zero_buffer_is_the_matchers_3_m_minimum(self):
        h = self.fold([row(dist=2.9, buf=None), row(tm=9, station="Z2", dist=3.1, buf=0)]).house_rows({})[0]
        self.assertEqual(h["offZonePct"], 50.0)

    def test_days_are_separate_for_gaps_and_duplicates(self):
        f = Q.Fold()
        f.add_day([row(day=D2, tm=0)])
        f.add_day([row(day=D1, tm=1)])
        s = f.scout_rows({})[0]
        self.assertEqual((s["tooFastPct"], s["duplicates"], s["activeDays"]), (None, 0, 2))
        self.assertEqual(s["scoutName"], "S1")
        self.assertEqual(s["moves"], 0)

    def test_house_figures(self):
        rows = [row(scout=f"S{i % 2}", tm=i * 10, station=f"Z{i}", dist=float(i), buf=4.5) for i in range(10)]
        rows.append(row(scout="S9", tm=0, station="Z99"))
        f = self.fold(rows)
        h = f.house_rows({})[0]
        self.assertEqual((h["house"], h["entries"], h["scouts"]), ("GH1", 11, 3))
        self.assertEqual((h["fixes"], h["metadataPct"], h["offZonePct"]), (10, 90.9, 50.0))
        self.assertEqual((h["medianDistance"], h["p90Distance"]), (4.0, 8.0))
        self.assertTrue(h["gpsReliable"])
        self.assertIsNone(h["coveragePct"])

    def test_house_takes_its_coverage_figure(self):
        f = self.fold([row()])
        cov = {"GH1": {"stations": 90, "scouted": 30, "coverage": 33.3, "sections_scouted": 6, "week": "2031-W40",
                       "partial": True}}
        h = f.house_rows(cov)[0]
        self.assertEqual((h["stations"], h["stationsScouted"], h["coveragePct"], h["sectionsScouted"], h["week"]),
                         (90, 30, 33.3, 6, "2031-W40"))
        self.assertTrue(h["weekPartial"])
        self.assertIsNone(h["staleDays"])

    def test_house_without_metadata_has_no_gps_figures(self):
        h = self.fold([row(), row(tm=50, station="Z2")]).house_rows({})[0]
        self.assertEqual((h["fixes"], h["metadataPct"], h["offZonePct"], h["medianDistance"]), (0, 0.0, None, None))
        self.assertFalse(h["gpsReliable"])

    def test_kpis(self):
        f = self.fold([row(tm=0, dist=9, buf=1, nothing=1), row(tm=1, station="Z2")])
        k = f.kpis([{"stations": 10, "coverage": 20.0}, {"stations": 30, "coverage": 40.0}, {"stations": 0, "coverage": None}])
        self.assertEqual(k["entries"], 2)
        self.assertEqual(k["coveragePct"], 35.0)
        self.assertEqual((k["offZonePct"], k["tooFastPct"], k["metadataPct"], k["nothingFoundPct"]), (100.0, 100.0, 50.0, 50.0))
        self.assertTrue(k["zoneMapSuspect"])  # scope off-zone 100% > 30%
        self.assertEqual((k["scouts"], k["houses"]), (1, 1))


def house(**kw):
    base = {"house": "GH1", "entries": 500, "fixes": 400, "metadataPct": 80.0, "medianDistance": 2.0,
            "coveragePct": 80.0, "gpsReliable": True}
    return {**base, **kw}


def scout(**kw):
    base = {"scout": "S1", "scoutName": "Sam", "entries": 500, "fixes": 400, "tooFastPct": 5.0,
            "nothingFoundPct": 50.0, "offZonePct": 10.0, "houseOffZonePct": 10.0, "duplicatePct": 1.0}
    return {**base, **kw}


def kinds(flags):
    return sorted((f["kind"], f["name"]) for f in flags)


class TestFlags(unittest.TestCase):
    def test_clean_rows_raise_nothing(self):
        self.assertEqual(Q.flag_rows([house()], [scout()], 50.0), [])

    def test_map_offset_needs_over_20_m_and_50_fixes(self):
        self.assertEqual(kinds(Q.flag_rows([house(medianDistance=20.0)], [], 0)), [])
        self.assertEqual(kinds(Q.flag_rows([house(medianDistance=20.1, fixes=49)], [], 0)), [])
        self.assertEqual(kinds(Q.flag_rows([house(medianDistance=20.1, fixes=50)], [], 0)),
                         [("map_offset", "GH1")])

    def test_thin_coverage_under_30(self):
        self.assertEqual(kinds(Q.flag_rows([house(coveragePct=30.0)], [], 0)), [])
        self.assertEqual(kinds(Q.flag_rows([house(coveragePct=29.9)], [], 0)), [("thin_coverage", "GH1")])
        self.assertEqual(kinds(Q.flag_rows([house(coveragePct=None)], [], 0)), [])

    def test_metadata_gap_under_50(self):
        self.assertEqual(kinds(Q.flag_rows([house(metadataPct=50.0)], [], 0)), [])
        self.assertEqual(kinds(Q.flag_rows([house(metadataPct=49.9)], [], 0)), [("metadata_gap", "GH1")])

    def test_too_fast_over_20(self):
        self.assertEqual(kinds(Q.flag_rows([], [scout(tooFastPct=20.0)], 50.0)), [])
        self.assertEqual(kinds(Q.flag_rows([], [scout(tooFastPct=20.1)], 50.0)), [("too_fast", "S1")])

    def test_nothing_found_25_points_over_the_scope_with_100_entries(self):
        self.assertEqual(kinds(Q.flag_rows([], [scout(nothingFoundPct=74.9)], 50.0)), [])
        self.assertEqual(kinds(Q.flag_rows([], [scout(nothingFoundPct=75.0, entries=99)], 50.0)), [])
        self.assertEqual(kinds(Q.flag_rows([], [scout(nothingFoundPct=75.0)], 50.0)), [("nothing_found", "S1")])

    def test_off_zone_is_25_points_over_the_scouts_houses_with_50_fixes(self):
        self.assertEqual(kinds(Q.flag_rows([], [scout(offZonePct=84.9, houseOffZonePct=60.0)], 50.0)), [])
        self.assertEqual(kinds(Q.flag_rows([], [scout(offZonePct=85.0, houseOffZonePct=60.0)], 50.0)),
                         [("off_zone", "S1")])
        self.assertEqual(kinds(Q.flag_rows([], [scout(offZonePct=85.0, houseOffZonePct=60.0, fixes=49)], 50.0)), [])
        self.assertEqual(kinds(Q.flag_rows([], [scout(offZonePct=None, houseOffZonePct=None, fixes=0)], 50.0)), [])

    def test_a_stale_house_is_not_scouted_recently_not_thin(self):
        flags = Q.flag_rows([house(coveragePct=5.0, week="2031-W38", staleDays=15)], [], 0)
        self.assertEqual(kinds(flags), [("not_scouted_recently", "GH1")])
        self.assertIn("15 days", flags[0]["detail"])
        self.assertEqual(kinds(Q.flag_rows([house(coveragePct=5.0, staleDays=14)], [], 0)), [("thin_coverage", "GH1")])

    def test_thin_coverage_on_a_partial_week_says_so(self):
        f = Q.flag_rows([house(coveragePct=10.0, week="2031-W41", weekPartial=True)], [], 0)[0]
        self.assertIn("partial week", f["detail"])

    def test_duplicates_over_2(self):
        self.assertEqual(kinds(Q.flag_rows([], [scout(duplicatePct=2.0)], 50.0)), [])
        self.assertEqual(kinds(Q.flag_rows([], [scout(duplicatePct=2.1)], 50.0)), [("duplicates", "S1")])

    def test_flags_rank_by_how_far_past_their_line(self):
        flags = Q.flag_rows(
            [house(house="A", coveragePct=27.0), house(house="B", medianDistance=60.0)],
            [scout(scout="S2", tooFastPct=30.0)],
            50.0,
        )
        self.assertEqual([(f["kind"], f["name"]) for f in flags],
                         [("map_offset", "B"), ("too_fast", "S2"), ("thin_coverage", "A")])
        top = flags[0]
        self.assertEqual((top["subject"], top["label"], top["value"], top["threshold"]),
                         ("house", "B", 60.0, 20.0))
        self.assertEqual(flags[1]["label"], "Sam")
