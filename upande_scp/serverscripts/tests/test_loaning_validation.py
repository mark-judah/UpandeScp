import unittest
from upande_scp.serverscripts.spray_plan_creator.loaning import validate_source_split

FARM = "Farm A"
LEND = {"Farm B": 10.0, "Farm C": 5.0}


class TestValidateSourceSplit(unittest.TestCase):
    def ok(self, sources, qty):
        return validate_source_split(sources, qty, FARM, LEND, 5)

    def test_valid_single_source(self):
        self.assertIsNone(self.ok([{"source_farm": "Farm B", "qty": 8}], 8))

    def test_valid_multi_source(self):
        self.assertIsNone(self.ok(
            [{"source_farm": "Farm B", "qty": 6}, {"source_farm": "Farm C", "qty": 4}], 10))

    def test_split_must_sum_to_requested(self):
        self.assertIn("add up", self.ok([{"source_farm": "Farm B", "qty": 5}], 8))

    def test_cannot_exceed_on_hand(self):
        self.assertIn("can only lend", self.ok([{"source_farm": "Farm C", "qty": 9}], 9))

    def test_cannot_loan_to_self(self):
        self.assertIn("itself", self.ok([{"source_farm": "Farm A", "qty": 5}], 5))

    def test_source_needs_farm_and_positive_qty(self):
        self.assertIn("positive", self.ok([{"source_farm": "Farm B", "qty": 0}], 0))

    def test_source_count_bounds(self):
        self.assertIn("between 1 and 5", self.ok([], 0))
        many = [{"source_farm": f"F{i}", "qty": 1} for i in range(6)]
        self.assertIn("between 1 and 5", self.ok(many, 6))
