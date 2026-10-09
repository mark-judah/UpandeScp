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
            ZONES_PER_GH, configure_rose_thresholds,
        )
        configure_rose_thresholds()
        with patch("upande_scp.serverscripts.scouting.scouting_metrics.get_zone_counts_by_greenhouse",
                   return_value=ZONES_PER_GH):
            p = greenhouse_detail({"greenhouse": "_TEST GH 1", "from_date": "2026-05-04",
                                   "to_date": "2026-05-15", "crop": "Rose"}, force=True)
        # GH 1 at 50% of zones: Thrips Adult (stage band High at 50) and the
        # 'Severe' Powdery Mildew (aggregate High at 40) are High; Thrips
        # Larvae is only Low. Two alerts.
        self.assertEqual(p["alerts"], 2)
