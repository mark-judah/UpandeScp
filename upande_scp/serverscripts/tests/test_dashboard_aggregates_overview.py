from frappe.tests.utils import FrappeTestCase
from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
    insert_fixture, _TEST_FARM_A,
)


class TestOverviewKpis(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def _call(self, **overrides):
        from upande_scp.serverscripts.dashboard_aggregates._overview import overview
        args = {
            "from_date": "2026-05-04",
            "to_date":   "2026-05-15",
            "crop": "",
            "farm": "",
            "greenhouse": "",
        }
        args.update(overrides)
        return overview(args)

    def test_total_scouts_counts_distinct_scouts_name(self):
        payload = self._call()
        # Fixture uses one scout for every row.
        self.assertEqual(payload["kpis"]["totalScouts"], 1)

    def test_zones_scouted_counts_entries_with_obs(self):
        payload = self._call()
        # 12 fixture rows but two have no obs at all (rows for 2026-05-10
        # and 2026-05-15 are trap-only — they still count).
        # All 12 have at least one of pests/diseases/traps.
        self.assertEqual(payload["kpis"]["zonesScouted"], 12)

    def test_greenhouse_count_unique_in_range(self):
        payload = self._call()
        self.assertEqual(payload["kpis"]["greenhouseCount"], 3)

    def test_crop_filter_restricts_results(self):
        payload = self._call(crop="Rose")
        self.assertEqual(payload["kpis"]["greenhouseCount"], 2)  # only GH 1 + GH 2


class TestOverviewDailyAndTotals(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def _call(self, **overrides):
        from upande_scp.serverscripts.dashboard_aggregates._overview import overview
        args = {
            "from_date": "2026-05-04", "to_date": "2026-05-15",
            "crop": "", "farm": "", "greenhouse": "",
        }
        args.update(overrides)
        return overview(args, force=True)  # bypass cache between assertions

    def test_daily_has_one_row_per_observed_date(self):
        payload = self._call()
        dates = {d["date"] for d in payload["daily"]}
        # 12 distinct dates in fixture
        self.assertEqual(len(dates), 12)

    def test_daily_pest_count_for_2026_05_06(self):
        # One entry on 2026-05-06: 1 pest obs (Thrips count=22) → counted as 1 row.
        payload = self._call()
        row = next(d for d in payload["daily"] if d["date"] == "2026-05-06")
        self.assertEqual(row["pests"], 1)
        self.assertEqual(row["diseases"], 0)
        self.assertEqual(row["traps"], 0)

    def test_range_totals(self):
        payload = self._call()
        self.assertEqual(payload["rangeTotals"]["pests"],    7)
        self.assertEqual(payload["rangeTotals"]["diseases"], 4)
        self.assertEqual(payload["rangeTotals"]["traps"],    4)

    def test_gh_health_ranked_by_total(self):
        payload = self._call()
        self.assertTrue(payload["ghHealth"])
        names = [g["name"] for g in payload["ghHealth"]]
        # GH 1 has most activity (pests-heavy) so it should be first.
        self.assertEqual(names[0], "_TEST GH 1")

    def test_active_alerts_high_first(self):
        from unittest.mock import patch
        from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
            configure_rose_thresholds, fixture_station_grid,
        )
        configure_rose_thresholds()
        with patch("upande_scp.serverscripts.dashboard_aggregates._prevalence_rows.station_grid",
                   side_effect=fixture_station_grid):
            payload = self._call(crop="Rose")
        sevs = [a["severity"] for a in payload["activeAlerts"]]
        # Was 5 High under the all-zones denominator (every cell 1 of 2 zones = 50%).
        # Prevalence is now per greenhouse's latest scouted ISO week over stations
        # SCOUTED (spec D1/D4): the one scouted station reads 100% for what it
        # carried that week and 0% otherwise.
        # High: GH 1 Thrips Adult (stage band 50), Thrips Larvae (aggregate band 90),
        # Powdery Mildew Severe (40); GH 2 Powdery Mildew Low. GH 2's Active and
        # Moderate cells were W19-only -> 0% -> unclassified.
        self.assertEqual(sevs.count("high"), 4)
        self.assertEqual(sevs, sorted(sevs, key=lambda s: s != "high"))
        high_kinds = {a["kind"] for a in payload["activeAlerts"] if a["severity"] == "high"}
        self.assertEqual(high_kinds, {"pest", "disease"})


class TestOverviewScouts(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def _call(self):
        from upande_scp.serverscripts.dashboard_aggregates._overview import overview
        return overview({
            "from_date": "2026-05-04", "to_date": "2026-05-15",
            "crop": "", "farm": "", "greenhouse": "",
        }, force=True)

    def test_top_scouts_returns_scout_ids(self):
        payload = self._call()
        ids = [s["scoutId"] for s in payload["topScouts"]]
        self.assertIn("_TEST Scout 001", ids)

    def test_scouts_per_day_distinct(self):
        payload = self._call()
        self.assertTrue(all(d["scouts"] == 1 for d in payload["scoutsPerDay"]))

    def test_recent_activity_top_8_with_scoutId(self):
        payload = self._call()
        self.assertLessEqual(len(payload["recentActivity"]), 8)
        for r in payload["recentActivity"]:
            self.assertIn("scoutId", r)
            self.assertIn("kind", r)
