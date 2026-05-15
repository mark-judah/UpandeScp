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


if __name__ == "__main__":
    unittest.main()
