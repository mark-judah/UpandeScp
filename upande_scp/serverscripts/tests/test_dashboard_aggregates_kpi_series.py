import datetime

from frappe.tests.utils import FrappeTestCase
from upande_scp.serverscripts.dashboard_aggregates._kpi_series import (
    KEYS, MIN_WEEKS, kpi_series, week_starts,
)
from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
    insert_fixture,
)


class TestWeekStarts(FrappeTestCase):
    def test_short_range_is_stretched_to_min_weeks(self):
        w = week_starts("2026-05-04", "2026-05-15")
        self.assertEqual(len(w), MIN_WEEKS)
        self.assertTrue(all(d.weekday() == 0 for d in w))
        self.assertEqual(w[-1], datetime.date(2026, 5, 11))

    def test_long_range_keeps_every_week(self):
        w = week_starts("2026-01-05", "2026-05-15")
        self.assertEqual(w[0], datetime.date(2026, 1, 5))
        self.assertEqual(len(w), 19)


class TestKpiSeriesEndpoint(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def test_one_point_per_week_for_every_key(self):
        p = kpi_series({
            "from_date": "2026-05-04", "to_date": "2026-05-15",
            "crop": "", "farm": "", "greenhouse": "",
        }, force=True)["series"]
        self.assertEqual(set(p), set(KEYS))
        for k in KEYS:
            self.assertEqual(len(p[k]), MIN_WEEKS)
            self.assertEqual(p[k][-1]["week"], "2026-W20")

    def test_trap_catches_land_in_their_weeks(self):
        p = kpi_series({
            "from_date": "2026-05-04", "to_date": "2026-05-15",
            "crop": "", "farm": "", "greenhouse": "",
        }, force=True)["series"]
        # The fixture's 48 FCM trap catches all fall inside the two ISO weeks.
        self.assertEqual(sum(x["value"] for x in p["fcm"]), 48)
        self.assertEqual(sum(x["value"] for x in p["catches"]), 48)
