from frappe.tests.utils import FrappeTestCase
from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
    insert_fixture,
)


class TestGreenhouseDetail(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def _call(self, gh):
        from upande_scp.serverscripts.dashboard_aggregates._gh_detail import (
            greenhouse_detail,
        )
        return greenhouse_detail({
            "greenhouse": gh,
            "from_date": "2026-05-04",
            "to_date":   "2026-05-15",
            "crop":      "",
        }, force=True)

    def test_top_pests_for_gh1(self):
        p = self._call("_TEST GH 1")
        names = [t["name"] for t in p["topPests"]]
        self.assertEqual(names[0], "_TEST Thrips")

    def test_traps_for_gh3(self):
        p = self._call("_TEST GH 3")
        self.assertTrue(p["traps"])
        self.assertEqual(p["traps"][0]["pest"], "_TEST False Codling Moth")

    def test_alerts_for_high_severity(self):
        from unittest.mock import patch
        from upande_scp.serverscripts.dashboard_aggregates._gh_detail import greenhouse_detail
        from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
            configure_rose_thresholds, fixture_station_grid,
        )
        configure_rose_thresholds()
        with patch("upande_scp.serverscripts.dashboard_aggregates._prevalence_rows.station_grid",
                   side_effect=fixture_station_grid):
            p = greenhouse_detail({"greenhouse": "_TEST GH 1", "from_date": "2026-05-04",
                                   "to_date": "2026-05-15", "crop": "Rose"}, force=True)
        # Was 2 under the all-zones denominator (50% of zones; Larvae only Low).
        # Station prevalence reads GH 1's latest scouted week, 2026-W20, where its one
        # scouted station carried Thrips Adult, Thrips Larvae and Powdery Mildew
        # Severe -> 100% each -> High on every band. Three alerts.
        self.assertEqual(p["alerts"], 3)
