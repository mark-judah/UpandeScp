import unittest

from upande_scp.serverscripts.spray_plan_creator.bom_resolver import build_bom_rows


class TestBuildBomRows(unittest.TestCase):
    def test_absolute_qty_and_per_1000l_rate(self):
        # water_volume = 6 L -> factor 0.006; required_qty IS the transfer.
        rows = build_bom_rows(
            [("1114009", 0.006), ("1111156005", 0.0018), ("1113018", 0.0018)],
            6,
        )
        self.assertAlmostEqual(rows["1114009"]["qty"], 0.006)
        self.assertAlmostEqual(rows["1114009"]["rate"], 1.0)
        self.assertAlmostEqual(rows["1111156005"]["qty"], 0.0018)
        self.assertAlmostEqual(rows["1111156005"]["rate"], 0.3)
        self.assertAlmostEqual(rows["1113018"]["qty"], 0.0018)
        self.assertAlmostEqual(rows["1113018"]["rate"], 0.3)

    def test_no_water_volume_rate_equals_qty(self):
        rows = build_bom_rows([("X", 0.5)], 0)
        self.assertAlmostEqual(rows["X"]["qty"], 0.5)
        self.assertAlmostEqual(rows["X"]["rate"], 0.5)

    def test_aggregates_duplicate_codes(self):
        # water_volume = 1000 -> factor 1.0, so rate == qty.
        rows = build_bom_rows([("X", 0.002), ("X", 0.004)], 1000)
        self.assertAlmostEqual(rows["X"]["qty"], 0.006)
        self.assertAlmostEqual(rows["X"]["rate"], 0.006)

    def test_skips_blank_codes(self):
        rows = build_bom_rows([("", 1), (None, 2), ("X", 3)], 1000)
        self.assertEqual(set(rows), {"X"})


class TestBomItemPayload(unittest.TestCase):
    def test_stock_qty_is_absolute_not_rate(self):
        from upande_scp.serverscripts.spray_plan_creator.bom_resolver import (
            bom_item_payload,
        )
        row = bom_item_payload("1114009", 0.006, 1.0, "Kilogram")
        # The fix: physical consumption fields hold the ABSOLUTE qty...
        self.assertEqual(row["qty"], 0.006)
        self.assertEqual(row["stock_qty"], 0.006)
        self.assertEqual(row["qty_consumed_per_unit"], 0.006)
        # ...and the per-1000L rate only lands on the display fields.
        self.assertEqual(row["custom_application_rate"], 1.0)
        self.assertEqual(row["custom_application_rateper_ha_"], 1.0)
        self.assertEqual(row["uom"], "Kilogram")
        self.assertEqual(row["stock_uom"], "Kilogram")
        self.assertEqual(row["include_item_in_manufacturing"], 1)
        self.assertEqual(row["conversion_factor"], 1)


if __name__ == "__main__":
    unittest.main()
