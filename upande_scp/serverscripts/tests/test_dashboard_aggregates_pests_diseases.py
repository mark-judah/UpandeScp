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
        payload = self._call()
        thrips = next(r for r in payload["ranking"] if r["name"] == "_TEST Thrips")
        # Thrips counts: 3, 7, 22, 4, 11 -> low (3,4), moderate (7,11), high (22)
        self.assertEqual(thrips["low"], 2)
        self.assertEqual(thrips["moderate"], 2)
        self.assertEqual(thrips["high"], 1)
