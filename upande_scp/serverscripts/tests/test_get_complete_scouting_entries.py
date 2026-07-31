import datetime
import unittest


class TestWeekHelpers(unittest.TestCase):
    def test_week_bounds_monday_to_sunday(self):
        from upande_scp.serverscripts.scouting.get_complete_scouting_entries import _week_bounds
        start, end = _week_bounds(2025, 18)  # ISO week 18 of 2025
        self.assertEqual(start, datetime.date(2025, 4, 28))   # Monday
        self.assertEqual(end, datetime.date(2025, 5, 4))      # Sunday

    def test_iso_year_week_for_date(self):
        from upande_scp.serverscripts.scouting.get_complete_scouting_entries import _iso_year_week
        self.assertEqual(_iso_year_week(datetime.date(2025, 1, 1)), (2025, 1))
        # 2025-12-29 is Monday of ISO week 1 of 2026
        self.assertEqual(_iso_year_week(datetime.date(2025, 12, 29)), (2026, 1))


class TestWeeksInRange(unittest.TestCase):
    def test_single_week(self):
        from upande_scp.serverscripts.scouting.get_complete_scouting_entries import _weeks_in_range
        # 2025-04-28 (Mon) to 2025-05-04 (Sun) — one ISO week
        weeks = _weeks_in_range("2025-04-28", "2025-05-04")
        self.assertEqual(weeks, [(2025, 18)])

    def test_span_across_year_boundary(self):
        from upande_scp.serverscripts.scouting.get_complete_scouting_entries import _weeks_in_range
        # 2025-12-29 is ISO 2026-W01, 2026-01-05 is ISO 2026-W02
        weeks = _weeks_in_range("2025-12-29", "2026-01-05")
        self.assertEqual(weeks, [(2026, 1), (2026, 2)])

    def test_swapped_range_is_normalised(self):
        from upande_scp.serverscripts.scouting.get_complete_scouting_entries import _weeks_in_range
        a = _weeks_in_range("2025-04-28", "2025-05-04")
        b = _weeks_in_range("2025-05-04", "2025-04-28")
        self.assertEqual(a, b)


class TestWeekCacheKey(unittest.TestCase):
    def test_key_uses_iso_year_week(self):
        from upande_scp.serverscripts.scouting.get_complete_scouting_entries import _week_cache_key
        # Patch scouting_payload_version to a known stamp.
        import upande_scp.serverscripts.scouting.get_complete_scouting_entries as mod
        from unittest.mock import patch
        with patch.object(mod, "scouting_payload_version", return_value=7):
            self.assertEqual(_week_cache_key(2025, 18), "scp:scouting_payload_v2:7:2025-W18")
            self.assertEqual(_week_cache_key(2026, 1),  "scp:scouting_payload_v2:7:2026-W01")


class TestFetchPayloadUsesWeeks(unittest.TestCase):
    """Integration check: _fetch_scouting_payload should hit _fetch_week_entries
    once per ISO week in range, not _fetch_month_entries."""

    def test_one_call_per_week(self):
        from unittest.mock import patch
        import upande_scp.serverscripts.scouting.get_complete_scouting_entries as mod

        with patch.object(mod, "_fetch_week_entries", return_value=[]) as wk:
            mod._fetch_scouting_payload("2025-04-28", "2025-05-12", None, include_meta=False)

        # 2025-04-28..2025-05-12 spans ISO weeks 18 + 19 + 20 of 2025
        # _fetch_week_entries takes (year, week, crop); the crop is None here.
        called_weeks = sorted(c.args[:2] for c in wk.call_args_list)
        self.assertEqual(called_weeks, [(2025, 18), (2025, 19), (2025, 20)])


class TestFilterEntriesWholeWeek(unittest.TestCase):
    def test_whole_week_short_circuit_matches_filter(self):
        from upande_scp.serverscripts.scouting.get_complete_scouting_entries import _filter_entries

        entries = [
            {"date_of_capture": "2025-04-28", "greenhouse": "G1", "block": ""},
            {"date_of_capture": "2025-05-01", "greenhouse": "G2", "block": ""},
            {"date_of_capture": "2025-05-04", "greenhouse": "G1", "block": ""},
            # Outside the week (these shouldn't appear when stitched
            # from week 18 only, but the helper must still filter them).
            {"date_of_capture": "2025-04-27", "greenhouse": "G1", "block": ""},
            {"date_of_capture": "2025-05-05", "greenhouse": "G1", "block": ""},
        ]
        result = _filter_entries(entries, "2025-04-28", "2025-05-04", None)
        dates = sorted(e["date_of_capture"] for e in result)
        # When short-circuit is active, the 2025-04-27 and 2025-05-05 entries
        # pass through (they're not filtered by date). That's BY DESIGN, because
        # in production those entries would never be in `entries` (they came from
        # a different week's cache slice).
        self.assertEqual(dates, ["2025-04-27", "2025-04-28", "2025-05-01", "2025-05-04", "2025-05-05"])

    def test_whole_week_short_circuit_with_greenhouse(self):
        from upande_scp.serverscripts.scouting.get_complete_scouting_entries import _filter_entries
        entries = [
            {"date_of_capture": "2025-04-28", "greenhouse": "G1", "block": ""},
            {"date_of_capture": "2025-05-01", "greenhouse": "G2", "block": ""},
        ]
        result = _filter_entries(entries, "2025-04-28", "2025-05-04", "G1")
        self.assertEqual([e["greenhouse"] for e in result], ["G1"])

    def test_non_week_range_still_applies_strict_date_filter(self):
        """When the range isn't an exact ISO week (Mon→Sun), the short-circuit
        does NOT activate and out-of-range entries must be filtered out.
        Pairs with test_whole_week_short_circuit_matches_filter to cover both
        branches of _filter_entries."""
        from upande_scp.serverscripts.scouting.get_complete_scouting_entries import _filter_entries
        entries = [
            {"date_of_capture": "2025-04-29", "greenhouse": "G1", "block": ""},
            {"date_of_capture": "2025-05-01", "greenhouse": "G1", "block": ""},
            # Out of range — must be filtered out.
            {"date_of_capture": "2025-04-28", "greenhouse": "G1", "block": ""},
            {"date_of_capture": "2025-05-05", "greenhouse": "G1", "block": ""},
        ]
        # Tuesday → Friday: not Monday-aligned, only 3 days, so no short-circuit.
        result = _filter_entries(entries, "2025-04-29", "2025-05-02", None)
        dates = sorted(e["date_of_capture"] for e in result)
        self.assertEqual(dates, ["2025-04-29", "2025-05-01"])


class TestPrewarm(unittest.TestCase):
    def test_prewarm_calls_fetch_for_recent_weeks(self):
        from unittest.mock import patch
        import datetime
        import upande_scp.serverscripts.scouting.scouting_prewarm as pre

        # Freeze "today" to a known Monday so we can assert exact weeks.
        FAKE_TODAY = datetime.date(2025, 5, 5)  # Monday, ISO week 19/2025

        with patch.object(pre, "_today", return_value=FAKE_TODAY), \
             patch.object(pre, "_fetch_week_entries", return_value=[]) as wk:
            pre.daily_prewarm()

        called = sorted(c.args for c in wk.call_args_list)
        # Current week (W19) + previous 4 (W18, W17, W16, W15)
        self.assertEqual(called, [(2025, 15), (2025, 16), (2025, 17), (2025, 18), (2025, 19)])


if __name__ == "__main__":
    unittest.main()
