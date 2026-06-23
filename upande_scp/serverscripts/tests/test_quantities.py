import unittest

from upande_scp.serverscripts.spray_plan_creator.quantities import absolute_to_rate


class TestAbsoluteToRate(unittest.TestCase):
    def test_recovers_per_1000l_rate_from_absolute(self):
        self.assertAlmostEqual(absolute_to_rate(0.1, 100), 1.0)
        self.assertAlmostEqual(absolute_to_rate(0.04, 100), 0.4)
        self.assertAlmostEqual(absolute_to_rate(1.0, 1000), 1.0)

    def test_zero_water_volume_returns_qty_unchanged(self):
        # Read-path safety for legacy rows with no water volume.
        self.assertAlmostEqual(absolute_to_rate(0.5, 0), 0.5)

    def test_zero_qty_is_zero(self):
        self.assertEqual(absolute_to_rate(0, 100), 0.0)


if __name__ == "__main__":
    unittest.main()
