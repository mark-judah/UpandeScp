import unittest
from upande_scp.serverscripts.store_keeper_api import bucket_overview


class TestBucketOverview(unittest.TestCase):
    def test_splits_and_totals_by_group(self):
        items = [
            {"item_code": "C1", "total_qty": 10},
            {"item_code": "F1", "total_qty": 4},
        ]
        warehouses = [{"warehouse": "W", "total_qty": 14, "item_count": 2}]
        matrix = [
            {"item_code": "C1", "warehouse": "W", "qty": 10},
            {"item_code": "F1", "warehouse": "W", "qty": 4},
        ]
        chem_items = {"C1"}  # everything else is fertilizer
        out = bucket_overview(items, warehouses, matrix, chem_items)
        self.assertAlmostEqual(out["chemical"]["total_qty"], 10)
        self.assertAlmostEqual(out["fertilizer"]["total_qty"], 4)
        self.assertEqual([i["item_code"] for i in out["chemical"]["items"]], ["C1"])
        self.assertEqual([i["item_code"] for i in out["fertilizer"]["items"]], ["F1"])
        self.assertEqual(out["chemical"]["stores"][0]["total_qty"], 10)
