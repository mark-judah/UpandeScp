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
