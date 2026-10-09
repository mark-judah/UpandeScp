from frappe.tests.utils import FrappeTestCase
from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
    insert_fixture,
)


class TestPestsEndpoint(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def _call(self, **overrides):
        from upande_scp.serverscripts.dashboard_aggregates._pests_diseases import pests
        args = {
            "from_date": "2026-05-04", "to_date": "2026-05-15",
            "crop": "", "farm": "", "greenhouse": "",
            "observation": "", "section": "", "stage": "",
        }
        args.update(overrides)
        return pests(args, force=True)

    def test_ranking_orders_by_total_count(self):
        payload = self._call()
        names = [r["name"] for r in payload["ranking"]]
        # Thrips total: 3+7+22+4+11 = 47; FCM total: 2+18 = 20.
        self.assertEqual(names[0], "_TEST Thrips")
        self.assertEqual(names[1], "_TEST False Codling Moth")

    def test_filter_options_lists_distinct_values(self):
        payload = self._call()
        self.assertEqual(set(payload["filterOptions"]["pests"]),
                         {"_TEST Thrips", "_TEST False Codling Moth"})
        self.assertIn("Leaf", payload["filterOptions"]["sections"])
        self.assertIn("Fruit", payload["filterOptions"]["sections"])

    def test_severity_buckets(self):
        from unittest.mock import patch
        from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
            configure_rose_thresholds, fixture_station_grid,
        )
        configure_rose_thresholds()
        with patch("upande_scp.serverscripts.dashboard_aggregates._prevalence_rows.station_grid",
                   side_effect=fixture_station_grid):
            payload = self._call(crop="Rose")
        thrips = next(r for r in payload["ranking"] if r["name"] == "_TEST Thrips")
        # Was High 1 / Low 1 under the all-zones denominator (each cell 1 of 2 zones = 50%).
        # Station prevalence reads GH 1's latest scouted week, 2026-W20, where its one
        # scouted station carried Thrips Adult and Larvae -> 100% each: Adult on its
        # stage band (High at 50), Larvae on the aggregate band (High at 90).
        self.assertEqual(thrips["high"], 2)
        self.assertEqual(thrips["moderate"], 0)
        self.assertEqual(thrips["low"], 0)


class TestPestsZoneMetrics(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def _call(self, **overrides):
        from upande_scp.serverscripts.dashboard_aggregates._pests_diseases import pests
        args = {
            "from_date": "2026-05-04", "to_date": "2026-05-15",
            "crop": "", "farm": "", "greenhouse": "",
            "observation": "", "section": "", "stage": "",
        }
        args.update(overrides)
        return pests(args, force=True)

    def test_distribution_returns_one_row_per_pest(self):
        payload = self._call()
        names = {d["name"] for d in payload["distribution"]}
        self.assertEqual(names, {"_TEST Thrips", "_TEST False Codling Moth"})

    def test_section_split_filters_by_observation(self):
        payload = self._call(observation="_TEST Thrips")
        names = {s["name"] for s in payload["sectionSplit"]}
        self.assertIn("Leaf", names)
        self.assertIn("Stem", names)

    def test_daily_percent_one_row_per_date_with_match(self):
        from unittest.mock import patch
        from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
            fixture_station_grid,
        )
        with patch("upande_scp.serverscripts.dashboard_aggregates._prevalence_rows.station_grid",
                   side_effect=fixture_station_grid):
            payload = self._call(observation="_TEST Thrips")
        dates = [r["date"] for r in payload["dailyPercent"]]
        # Was one row per scouting DATE with Thrips (all-zones denominator). The trend
        # is now weekly adjusted prevalence (spec 2), one point per ISO week with
        # scouting, dated on its Monday: 2026-W19 and 2026-W20.
        self.assertEqual(dates, ["2026-05-04", "2026-05-11"])

    def test_trend_series_top_n(self):
        payload = self._call()
        self.assertEqual(set(payload["trendSeries"]["keys"]),
                         {"_TEST Thrips", "_TEST False Codling Moth"})


class TestDiseasesEndpoint(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def test_diseases_endpoint_returns_disease_keyed_filter_options(self):
        from upande_scp.serverscripts.dashboard_aggregates._pests_diseases import (
            diseases,
        )
        payload = diseases({
            "from_date": "2026-05-04", "to_date": "2026-05-15",
            "crop": "", "farm": "", "greenhouse": "",
            "observation": "", "section": "", "stage": "",
        }, force=True)
        self.assertIn("diseases", payload["filterOptions"])
        self.assertIn("_TEST Powdery Mildew", payload["filterOptions"]["diseases"])
        self.assertTrue(payload["ranking"])
