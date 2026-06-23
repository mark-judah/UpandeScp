from frappe.tests.utils import FrappeTestCase
from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
    insert_fixture,
)


class TestFcmEndpoint(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def _call(self):
        from upande_scp.serverscripts.dashboard_aggregates._fcm import fcm
        return fcm({
            "from_date": "2026-05-04", "to_date": "2026-05-15",
            "crop": "", "farm": "", "greenhouse": "",
        }, force=True)

    def test_kpis(self):
        p = self._call()
        self.assertEqual(p["kpis"]["trapTotal"], 48)
        self.assertEqual(p["kpis"]["pestTotal"], 20)
        self.assertEqual(p["kpis"]["greenhouseCount"], 1)

    def test_daily_has_traps_and_scouting(self):
        p = self._call()
        dates = [d["date"] for d in p["daily"]]
        # Trap dates: 2026-05-09, 10, 13, 15. Pest FCM dates: 09, 13. Union = 4.
        self.assertEqual(set(dates), {"2026-05-09", "2026-05-10", "2026-05-13",
                                      "2026-05-15"})
        sample = p["daily"][0]
        self.assertIn("traps", sample)
        self.assertIn("scouting", sample)

    def test_breakdown_filters_focus_only(self):
        p = self._call()
        names = {b["name"] for b in p["pestBreakdown"]}
        self.assertEqual(names, {"_TEST False Codling Moth"})

    def test_focus_pests_list_top_n(self):
        p = self._call()
        names = [r["name"] for r in p["focusPests"]]
        self.assertIn("_TEST False Codling Moth", names)
