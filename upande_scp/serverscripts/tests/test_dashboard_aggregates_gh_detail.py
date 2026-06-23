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
        p = self._call("_TEST GH 1")
        # GH 1: pest count of 22 (>15 → high). +1 alert.
        # 2026-05-14 has a 'Severe' disease. +1 alert.
        self.assertGreaterEqual(p["alerts"], 2)
