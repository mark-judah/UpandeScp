import unittest
from upande_scp.serverscripts.store_keeper_api import bucket_overview


class TestBucketOverview(unittest.TestCase):
    def test_splits_and_totals_by_group_and_store(self):
        matrix = [
            {"item_code": "C1", "warehouse": "W", "qty": 10},
            {"item_code": "F1", "warehouse": "W", "qty": 4},
        ]
        chem_items = {"C1"}  # everything else is fertilizer
        chem_stores = {"W"}
        fert_stores = {"W"}
        out = bucket_overview(matrix, chem_items, chem_stores, fert_stores)
        self.assertAlmostEqual(out["chemical"]["total_qty"], 10)
        self.assertAlmostEqual(out["fertilizer"]["total_qty"], 4)
        self.assertEqual([i["item_code"] for i in out["chemical"]["items"]], ["C1"])
        self.assertEqual([i["item_code"] for i in out["fertilizer"]["items"]], ["F1"])
        self.assertEqual(out["chemical"]["stores"][0]["total_qty"], 10)

    def test_excludes_warehouses_not_in_mapped_store_set(self):
        # A CSU warehouse holding chemical (and fertilizer) stock must NOT
        # leak into either bucket just because it's present in the matrix —
        # only warehouses in ``chem_stores``/``fert_stores`` (each farm's
        # mapped store) may appear, per-bucket.
        matrix = [
            {"item_code": "C1", "warehouse": "Mapped Chem Store", "qty": 10},
            {"item_code": "C1", "warehouse": "Some CSU", "qty": 50},
            {"item_code": "F1", "warehouse": "Mapped Fert Store", "qty": 4},
            {"item_code": "F1", "warehouse": "Some CSU", "qty": 20},
        ]
        chem_items = {"C1"}
        chem_stores = {"Mapped Chem Store"}
        fert_stores = {"Mapped Fert Store"}
        out = bucket_overview(matrix, chem_items, chem_stores, fert_stores)

        chem_wh_names = {s["warehouse"] for s in out["chemical"]["stores"]}
        fert_wh_names = {s["warehouse"] for s in out["fertilizer"]["stores"]}
        self.assertEqual(chem_wh_names, {"Mapped Chem Store"})
        self.assertNotIn("Some CSU", chem_wh_names)
        self.assertEqual(fert_wh_names, {"Mapped Fert Store"})
        self.assertNotIn("Some CSU", fert_wh_names)
        self.assertAlmostEqual(out["chemical"]["total_qty"], 10)
        self.assertAlmostEqual(out["fertilizer"]["total_qty"], 4)
