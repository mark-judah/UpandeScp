from frappe.tests.utils import FrappeTestCase
from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
    insert_fixture,
)


class TestTrapsEndpoint(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def _call(self):
        from upande_scp.serverscripts.dashboard_aggregates._traps import traps
        return traps({
            "from_date": "2026-05-04", "to_date": "2026-05-15",
            "crop": "", "farm": "", "greenhouse": "",
        }, force=True)

    def test_ranking_by_pest_total(self):
        payload = self._call()
        # Trap counts: 5 + 12 + 30 + 1 = 48 for FCM via Yellow Sticky.
        first = payload["ranking"][0]
        self.assertEqual(first["trap"], "_TEST Yellow Sticky")
        self.assertEqual(first["pest"], "_TEST False Codling Moth")
        self.assertEqual(first["total"], 48)
        self.assertEqual(first["avg"], 12)  # 48/4 → 12

    def test_pest_breakdown(self):
        payload = self._call()
        names = {b["name"]: b["value"] for b in payload["pestBreakdown"]}
        self.assertEqual(names["_TEST False Codling Moth"], 48)

    def test_trend_series_keys_and_rows(self):
        payload = self._call()
        self.assertEqual(set(payload["trendSeries"]["keys"]),
                         {"_TEST False Codling Moth"})
        self.assertEqual(len(payload["trendSeries"]["rows"]), 4)
