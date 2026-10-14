import unittest

from upande_scp.serverscripts.spray_plan_creator.reservations import (
    RESERVED_EXCLUDED_STATES,
    is_reserved_state,
    aggregate_reservations,
    window_start,
    reserves,
    is_stale,
    compute_available,
    check_rows,
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

    def test_closed_and_cancelled_are_not_reserved(self):
        self.assertFalse(is_reserved_state("Approved", "Closed"))
        self.assertFalse(is_reserved_state("Approved", "Cancelled"))

    def test_direct_issue_is_not_reserved(self):
        self.assertFalse(is_reserved_state("Chemicals Issued Direct", None))

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


class TestWindow(unittest.TestCase):
    def test_window_start(self):
        self.assertEqual(window_start("2026-10-14", 7), "2026-10-07")
        self.assertEqual(window_start("2026-03-03 10:00:00", 7), "2026-02-24")

    def test_reserves_inside_window_only(self):
        cut = "2026-10-07"
        base = {"docstatus": 1, "status": "Not Started", "workflow_state": "Approved"}
        self.assertTrue(reserves(dict(base, planned_start_date="2026-10-07 06:00:00"), cut))
        self.assertTrue(reserves(dict(base, planned_start_date="2026-10-20"), cut))
        self.assertFalse(reserves(dict(base, planned_start_date="2026-10-06 23:00:00"), cut))

    def test_issued_or_cancelled_never_reserve(self):
        cut = "2026-10-07"
        d = {"planned_start_date": "2026-10-10", "status": None}
        self.assertFalse(reserves(dict(d, docstatus=1, workflow_state="Chemical Issued"), cut))
        self.assertFalse(reserves(dict(d, docstatus=2, workflow_state="Approved"), cut))

    def test_stale_is_old_but_otherwise_live(self):
        cut = "2026-10-07"
        old = {"docstatus": 1, "status": None, "workflow_state": "Awaiting Approval",
               "planned_start_date": "2026-09-01"}
        self.assertTrue(is_stale(old, cut))
        self.assertFalse(is_stale(dict(old, workflow_state="Completed"), cut))
        self.assertFalse(is_stale(dict(old, status="Stopped"), cut))
        self.assertFalse(is_stale(dict(old, planned_start_date="2026-10-08"), cut))


class TestGateMath(unittest.TestCase):
    def test_compute_available_is_unfloored(self):
        self.assertAlmostEqual(compute_available(10, 4, 8), -2.0)

    def test_ok_when_enough(self):
        rows = [{"item_code": "A", "source_warehouse": "W", "required_qty": 5}]
        self.assertEqual(check_rows(rows, {("A", "W"): 10}, {("A", "W"): 5}, {}, {}), [])

    def test_item_shortfall(self):
        rows = [{"item_code": "A", "source_warehouse": "W", "required_qty": 6}]
        out = check_rows(rows, {("A", "W"): 10}, {("A", "W"): 5}, {}, {})
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["level"], "item")
        self.assertAlmostEqual(out[0]["available"], 5.0)

    def test_split_rows_are_summed(self):
        rows = [{"item_code": "A", "source_warehouse": "W", "required_qty": 4},
                {"item_code": "A", "source_warehouse": "W", "required_qty": 4}]
        self.assertEqual(len(check_rows(rows, {("A", "W"): 6}, {}, {}, {})), 1)

    def test_batch_shortfall_even_when_item_ok(self):
        rows = [{"item_code": "A", "source_warehouse": "W", "required_qty": 5, "batch_no": "B1"}]
        out = check_rows(rows, {("A", "W"): 50}, {}, {("A", "W", "B1"): 3},
                         {("A", "W", "B1"): 6})
        self.assertEqual([o["level"] for o in out], ["batch"])
        self.assertAlmostEqual(out[0]["available"], 3.0)

    def test_no_stock_at_all(self):
        rows = [{"item_code": "A", "source_warehouse": "W", "required_qty": 1}]
        self.assertEqual(len(check_rows(rows, {}, {}, {}, {})), 1)
