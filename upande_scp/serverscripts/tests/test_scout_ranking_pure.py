"""Scout ranking (personnel spec P4) — runs under plain pytest, no site."""

import unittest
from datetime import date

from upande_scp.serverscripts.common import quality_rules as Q
from upande_scp.serverscripts.common import scout_ranking as SR

FARM_OF = {"GH1": "A", "GH2": "A", "GH9": "B"}


def scout(sid, days=5, entries=100, spd=10.0, fast=0.0, dup=0.0, off=10.0, base=10.0, fixes=50,
          houses=(("GH1", 100),)):
    return {"scout": sid, "scoutName": sid, "entries": entries, "activeDays": days,
            "stationsPerDay": spd, "tooFastPct": fast, "duplicatePct": dup, "offZonePct": off,
            "houseOffZonePct": base, "fixes": fixes, "entriesPerHour": None, "nothingFoundPct": None,
            "houses": [{"house": h, "entries": n} for h, n in houses]}


class TestParts(unittest.TestCase):
    def test_median(self):
        self.assertEqual(SR.median([3, None, 1, 2]), 2)
        self.assertEqual(SR.median([1, 2, 3, 10]), 2.5)
        self.assertIsNone(SR.median([None]))

    def test_effort_is_capped_at_the_farm_median(self):
        self.assertEqual(SR.effort(5, 10), 50.0)
        self.assertEqual(SR.effort(20, 10), 100.0)
        self.assertEqual(SR.effort(None, 10), 0.0)
        self.assertEqual(SR.effort(3, 0), 100.0)

    def test_integrity_is_floored_at_zero(self):
        self.assertEqual(SR.integrity(10, 2.5), 87.5)
        self.assertEqual(SR.integrity(90, 30), 0.0)
        self.assertEqual(SR.integrity(None, None), 100.0)

    def test_gps_is_the_excess_over_their_houses(self):
        self.assertEqual(SR.gps(40, 10, 60), (70.0, None))
        self.assertEqual(SR.gps(5, 10, 60), (100.0, None))  # better than the house: no bonus
        self.assertEqual(SR.gps(None, None, 0), (None, SR.NOTE_NO_GPS))
        self.assertEqual(SR.gps(20, None, 9), (None, SR.NOTE_NO_BASELINE))

    def test_score_from_its_parts(self):
        self.assertEqual(SR.score(50, 100, 80), round(0.4 * 50 + 0.3 * 100 + 0.3 * 80, 1))
        self.assertAlmostEqual(SR.EFFORT_WEIGHT + SR.INTEGRITY_WEIGHT + SR.GPS_WEIGHT, 1.0)


class TestRank(unittest.TestCase):
    def test_five_day_minimum(self):
        out = SR.rank([scout("S1", days=5), scout("S2", days=4)], FARM_OF)
        self.assertEqual([r["scout"] for r in out["ranked"]], ["S1"])
        self.assertEqual([r["scout"] for r in out["notEnoughDays"]], ["S2"])
        self.assertNotIn("score", out["notEnoughDays"][0])

    def test_effort_against_own_farm_median(self):
        rows = [scout("A1", spd=10), scout("A2", spd=20), scout("A3", spd=30),
                scout("B1", spd=5, houses=(("GH9", 100),))]
        out = SR.rank(rows, FARM_OF)
        by = {r["scout"]: r for r in out["ranked"]}
        self.assertEqual(by["A1"]["effort"], 50.0)   # 10 / median 20
        self.assertEqual(by["A3"]["effort"], 100.0)  # capped
        self.assertEqual(by["B1"]["effort"], 100.0)  # alone on farm B: its own median
        self.assertEqual(by["B1"]["farm"], "B")
        med = out["medians"]["A"]
        self.assertEqual((med["stationsPerDay"], med["scouts"]), (20.0, 3))

    def test_medians_ignore_scouts_with_too_few_days(self):
        out = SR.rank([scout("A1", spd=10), scout("A2", spd=1000, days=2)], FARM_OF)
        self.assertEqual(out["medians"]["A"]["stationsPerDay"], 10.0)
        self.assertEqual(out["ranked"][0]["effort"], 100.0)

    def test_tie_goes_to_more_entries(self):
        out = SR.rank([scout("S1", entries=100), scout("S2", entries=300)], FARM_OF)
        self.assertEqual([(r["scout"], r["rank"]) for r in out["ranked"]], [("S2", 1), ("S1", 2)])
        self.assertEqual(out["ranked"][0]["score"], out["ranked"][1]["score"])

    def test_no_gps_takes_the_farm_average_with_a_note(self):
        rows = [scout("S1", off=30, base=10), scout("S2", off=10, base=10),
                scout("S3", off=None, base=None, fixes=0)]
        by = {r["scout"]: r for r in SR.rank(rows, FARM_OF)["ranked"]}
        self.assertEqual(by["S3"]["gps"], 90.0)  # (80 + 100) / 2
        self.assertEqual(by["S3"]["gpsNote"], SR.NOTE_NO_GPS)
        self.assertIsNone(by["S1"]["gpsNote"])

    def test_ranks_by_score(self):
        rows = [scout("Fast", fast=50), scout("Good"), scout("Slow", spd=2)]
        out = SR.rank(rows, FARM_OF)
        self.assertEqual([r["scout"] for r in out["ranked"]], ["Good", "Fast", "Slow"])
        good = out["ranked"][0]
        self.assertEqual((good["effort"], good["integrity"], good["gps"], good["score"]), (100.0, 100.0, 100.0, 100.0))


class TestFoldFeedsTheRanking(unittest.TestCase):
    def test_scout_rows_carry_stations_houses_weeks_and_last_date(self):
        f = Q.Fold()
        d1, d2 = date(2031, 9, 28), date(2031, 9, 29)  # Sunday W39, Monday W40
        f.add_day([("S1", d1, "GH1", "Z1", "B1", 0, None, None, None, 0),
                   ("S1", d1, "GH1", "Z1", "B1", 1, None, None, None, 0),
                   ("S1", d1, "GH2", "Z2", "B1", 60, None, None, None, 0)])
        f.add_day([("S1", d2, "GH2", "Z3", "B1", 0, None, None, None, 0)])
        s = f.scout_rows({})[0]
        self.assertEqual(s["stationsPerDay"], 1.5)  # (2 + 1) / 2 days
        self.assertEqual(s["houses"], [{"house": "GH1", "entries": 2}, {"house": "GH2", "entries": 2}])
        self.assertEqual(s["weeks"], [{"week": 203139, "entries": 3}, {"week": 203140, "entries": 1}])
        self.assertEqual(s["lastDate"], "2031-09-29")
