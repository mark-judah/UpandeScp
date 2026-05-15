import datetime
import unittest


class TestWeekHelpers(unittest.TestCase):
    def test_week_bounds_monday_to_sunday(self):
        from upande_scp.serverscripts.get_complete_scouting_entries import _week_bounds
        start, end = _week_bounds(2025, 18)  # ISO week 18 of 2025
        self.assertEqual(start, datetime.date(2025, 4, 28))   # Monday
        self.assertEqual(end, datetime.date(2025, 5, 4))      # Sunday

    def test_iso_year_week_for_date(self):
        from upande_scp.serverscripts.get_complete_scouting_entries import _iso_year_week
        self.assertEqual(_iso_year_week(datetime.date(2025, 1, 1)), (2025, 1))
        # 2025-12-29 is Monday of ISO week 1 of 2026
        self.assertEqual(_iso_year_week(datetime.date(2025, 12, 29)), (2026, 1))


class TestWeeksInRange(unittest.TestCase):
    def test_single_week(self):
        from upande_scp.serverscripts.get_complete_scouting_entries import _weeks_in_range
        # 2025-04-28 (Mon) to 2025-05-04 (Sun) — one ISO week
        weeks = _weeks_in_range("2025-04-28", "2025-05-04")
        self.assertEqual(weeks, [(2025, 18)])

    def test_span_across_year_boundary(self):
        from upande_scp.serverscripts.get_complete_scouting_entries import _weeks_in_range
        # 2025-12-29 is ISO 2026-W01, 2026-01-05 is ISO 2026-W02
        weeks = _weeks_in_range("2025-12-29", "2026-01-05")
        self.assertEqual(weeks, [(2026, 1), (2026, 2)])

    def test_swapped_range_is_normalised(self):
        from upande_scp.serverscripts.get_complete_scouting_entries import _weeks_in_range
        a = _weeks_in_range("2025-04-28", "2025-05-04")
        b = _weeks_in_range("2025-05-04", "2025-04-28")
        self.assertEqual(a, b)


class TestWeekCacheKey(unittest.TestCase):
    def test_key_uses_iso_year_week(self):
        from upande_scp.serverscripts.get_complete_scouting_entries import _week_cache_key
        # Patch scouting_payload_version to a known stamp.
        import upande_scp.serverscripts.get_complete_scouting_entries as mod
        from unittest.mock import patch
        with patch.object(mod, "scouting_payload_version", return_value=7):
            self.assertEqual(_week_cache_key(2025, 18), "scp:scouting_payload_v2:7:2025-W18")
            self.assertEqual(_week_cache_key(2026, 1),  "scp:scouting_payload_v2:7:2026-W01")


if __name__ == "__main__":
    unittest.main()
