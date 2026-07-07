import unittest

from upande_scp.serverscripts.spray_plan_creator.reservations import (
    RESERVED_EXCLUDED_STATES,
    is_reserved_state,
    aggregate_reservations,
)


class TestIsReservedState(unittest.TestCase):
    def test_none_workflow_state_counts_as_draft(self):
        self.assertTrue(is_reserved_state(None, None))

    def test_pending_and_awaiting_and_approved_are_reserved(self):
        for s in ("Pending Submission", "Awaiting Approval", "Approved"):
            self.assertTrue(is_reserved_state(s, None), s)

    def test_issued_and_later_are_not_reserved(self):
        for s in RESERVED_EXCLUDED_STATES:
            self.assertFalse(is_reserved_state(s, None), s)

    def test_stopped_status_is_not_reserved(self):
        self.assertFalse(is_reserved_state("Approved", "Stopped"))


class TestAggregateReservations(unittest.TestCase):
    def test_sums_by_item_and_warehouse(self):
        rows = [
            {"item_code": "A", "source_warehouse": "W1", "required_qty": 2.0},
            {"item_code": "A", "source_warehouse": "W1", "required_qty": 3.0},
            {"item_code": "A", "source_warehouse": "W2", "required_qty": 1.0},
            {"item_code": "B", "source_warehouse": "W1", "required_qty": 5.0},
        ]
        out = aggregate_reservations(rows)
        self.assertAlmostEqual(out["A"]["W1"], 5.0)
        self.assertAlmostEqual(out["A"]["W2"], 1.0)
        self.assertAlmostEqual(out["B"]["W1"], 5.0)

    def test_skips_blank_item_or_warehouse_and_treats_none_qty_as_zero(self):
        rows = [
            {"item_code": "", "source_warehouse": "W1", "required_qty": 9},
            {"item_code": "A", "source_warehouse": None, "required_qty": 9},
            {"item_code": "A", "source_warehouse": "W1", "required_qty": None},
        ]
        out = aggregate_reservations(rows)
        self.assertEqual(out, {"A": {"W1": 0.0}})
