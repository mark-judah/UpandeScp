"""Heatmap cards bucket by ISO week, not by scouting session.

Scouts cover a greenhouse in two passes — odd beds one session, even beds the
next — so a per-session heatmap draws half a house and renders the unvisited
half as if it were clean. Measured on this site: sessions split 930 even / 16
odd and 896 odd / 16 even, each touching 114 of 224 beds, and 101 of 229
greenhouse-weeks got only one half.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_heatmaps_weekly
"""

import unittest
from importlib import import_module

_hm = import_module("upande_scp.serverscripts.dashboard_aggregates._heatmaps")

ZONE = "Torongo GH 07 - KR - Bed {n} - Zone 3"


def row(date, zone, obs="Thrips", n=1, gh="GH 07", stage="Adult"):
    return {"greenhouse": gh, "obs_name": obs, "d": date, "zone": zone,
            "stage": stage, "n": n}


class TestBedParity(unittest.TestCase):
    def test_reads_the_bed_number_not_the_greenhouse_number(self):
        # "Torongo GH 07 - KR - Bed 51 ..." must resolve from Bed 51 (odd),
        # never from the "07" in the greenhouse name.
        self.assertEqual(_hm.bed_parity("Torongo GH 07 - KR - Bed 51 - Zone 9"), "odd")
        self.assertEqual(_hm.bed_parity("Torongo GH 07 - KR - Bed 52 - Zone 9"), "even")

    def test_no_bed_number_is_unknown(self):
        self.assertIsNone(_hm.bed_parity("Torongo GH 07 - KR"))
        self.assertIsNone(_hm.bed_parity(""))
        self.assertIsNone(_hm.bed_parity(None))


class TestParityBalanced(unittest.TestCase):
    def test_a_one_sided_session_is_not_complete(self):
        # The real failure this guards: a stray odd zone inside an even-bed
        # session must not pass as "the whole greenhouse was seen".
        self.assertFalse(_hm.parity_balanced(odd=1, even=182))
        self.assertFalse(_hm.parity_balanced(odd=16, even=930))

    def test_a_two_pass_week_is_complete(self):
        self.assertTrue(_hm.parity_balanced(odd=896, even=930))
        self.assertTrue(_hm.parity_balanced(odd=100, even=180))

    def test_a_single_parity_is_never_complete(self):
        self.assertFalse(_hm.parity_balanced(odd=500, even=0))
        self.assertFalse(_hm.parity_balanced(odd=0, even=0))


class TestWeeklyCards(unittest.TestCase):
    def cards(self, rows, weeks_limit=3):
        return _hm._build_cards(rows, "pest", {}, weeks_limit=weeks_limit)

    def test_sessions_in_one_week_merge_into_a_single_full_house_view(self):
        # 2026-07-08 even beds, 2026-07-10 odd beds — both ISO week 28.
        rows = [row("2026-07-08", ZONE.format(n=2)), row("2026-07-08", ZONE.format(n=4)),
                row("2026-07-10", ZONE.format(n=1)), row("2026-07-10", ZONE.format(n=3))]
        c = self.cards(rows)[0]
        self.assertEqual([r["date"] for r in c["recent"]], ["2026-W28"])
        wk = c["recent"][0]
        self.assertEqual(wk["sessions"], 2)
        self.assertEqual(len(wk["zoneObs"]), 4)   # both halves, one picture
        self.assertTrue(wk["complete"])

    def test_a_single_parity_week_is_flagged_incomplete(self):
        rows = [row("2026-07-13", ZONE.format(n=n)) for n in (2, 4, 6, 8)]
        wk = self.cards(rows)[0]["recent"][0]
        self.assertEqual(wk["sessions"], 1)
        self.assertFalse(wk["complete"], "one-parity week must not claim a full view")

    def test_weeks_are_oldest_first_so_the_latest_reads_last(self):
        rows = [row("2026-06-29", ZONE.format(n=1)),   # W27
                row("2026-07-08", ZONE.format(n=2)),   # W28
                row("2026-07-13", ZONE.format(n=4))]   # W29
        c = self.cards(rows)[0]
        self.assertEqual([r["date"] for r in c["recent"]], ["2026-W27", "2026-W28", "2026-W29"])
        self.assertEqual(c["lastDate"], "2026-W29")

    def test_only_the_most_recent_weeks_are_kept(self):
        rows = [row(d, ZONE.format(n=1)) for d in
                ("2026-06-15", "2026-06-22", "2026-06-29", "2026-07-08", "2026-07-13")]
        c = self.cards(rows, weeks_limit=3)[0]
        self.assertEqual([r["date"] for r in c["recent"]],
                         ["2026-W27", "2026-W28", "2026-W29"])

    def test_grid_path_keeps_one_week_and_it_is_the_latest(self):
        rows = [row("2026-06-29", ZONE.format(n=1)), row("2026-07-13", ZONE.format(n=2))]
        c = self.cards(rows, weeks_limit=1)[0]
        self.assertEqual([r["date"] for r in c["recent"]], ["2026-W29"])

    def test_totals_still_count_every_session(self):
        rows = [row("2026-07-08", ZONE.format(n=2), n=5),
                row("2026-07-10", ZONE.format(n=1), n=3)]
        c = self.cards(rows)[0]
        self.assertEqual(c["totalObs"], 8)
        self.assertEqual(c["zonesAffected"], 2)
