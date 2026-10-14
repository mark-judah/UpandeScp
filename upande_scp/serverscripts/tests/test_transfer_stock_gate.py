"""The pure stock-gate arithmetic: which waiting transfers cannot go out."""

import unittest

from upande_scp.serverscripts.store import transfer_stock_gate as G

WH = "Store"


def row(t, qty, batch=None, planned=None, item="I", date="2026-01-01", created="1"):
    return {"transfer": t, "planned_date": date, "created": created, "item_code": item,
            "warehouse": WH, "qty": qty, "batch_no": batch or "", "planned_batch": planned or ""}


S10 = ({("I", WH): 30}, {("I", WH, "B1"): 10, ("I", WH, "B2"): 20})


class TestGate(unittest.TestCase):
    def test_batch_shortage_while_item_total_is_fine(self):
        rows = [row("A", 6, "B1"), row("B", 6, "B1")]
        res = G.evaluate(rows, *S10, selected=["A", "B"])
        self.assertTrue(res["A"]["ok"])
        self.assertFalse(res["B"]["ok"])
        s = res["B"]["shorts"][0]
        self.assertEqual((s["batch_no"], s["needed"], s["available_when_its_turn"], s["short_by"]),
                         ("B1", 6, 4, 2))
        self.assertEqual(s["blocking_transfers"], ["A"])
        msg = G.short_message(res["B"]["shorts"])
        self.assertIn("batch B1", msg)
        self.assertIn("needs 6, 4 left after A", msg)

    def test_item_shortage(self):
        rows = [row("A", 6), row("B", 6)]
        res = G.evaluate(rows, {("I", WH): 10}, {}, selected=["A", "B"])
        self.assertTrue(res["A"]["ok"])
        self.assertFalse(res["B"]["ok"])
        self.assertIsNone(res["B"]["shorts"][0]["batch_no"])
        self.assertEqual(res["B"]["shorts"][0]["blocking_transfers"], ["A"])

    def test_selected_order_wins_over_planned_date(self):
        rows = [row("A", 6, "B1", date="2026-01-01"), row("B", 6, "B1", date="2026-01-09")]
        res = G.evaluate(rows, *S10, selected=["B", "A"])
        self.assertTrue(res["B"]["ok"])
        self.assertFalse(res["A"]["ok"])
        self.assertEqual(res["A"]["shorts"][0]["blocking_transfers"], ["B"])

    def test_unselected_rows_do_not_consume(self):
        rows = [row("A", 6, "B1"), row("B", 6, "B1"), row("C", 6, "B1")]
        res = G.evaluate(rows, *S10, selected=["A"])
        self.assertTrue(res["A"]["ok"])
        # B and C are each judged after A only; neither takes stock from the other
        for n in ("B", "C"):
            self.assertFalse(res[n]["ok"])
            self.assertEqual(res[n]["shorts"][0]["available_when_its_turn"], 4)
            self.assertEqual(res[n]["shorts"][0]["blocking_transfers"], ["A"])

    def test_nothing_selected_each_judged_alone(self):
        rows = [row("A", 6, "B1"), row("B", 6, "B1"), row("C", 11, "B1")]
        res = G.evaluate(rows, *S10)
        self.assertTrue(res["A"]["ok"] and res["B"]["ok"])
        self.assertFalse(res["C"]["ok"])

    def test_unselected_judged_after_selected(self):
        rows = [row("A", 6, "B1"), row("B", 4, "B1")]
        self.assertTrue(G.evaluate(rows, *S10, selected=["A"])["B"]["ok"])  # exact fit
        rows = [row("A", 7, "B1"), row("B", 4, "B1")]
        self.assertFalse(G.evaluate(rows, *S10, selected=["A"])["B"]["ok"])

    def test_unticking_frees_stock(self):
        rows = [row("A", 6, "B1"), row("B", 6, "B1")]
        self.assertFalse(G.evaluate(rows, *S10, selected=["A"])["B"]["ok"])
        self.assertTrue(G.evaluate(rows, *S10, selected=[])["B"]["ok"])

    def test_select_all_is_greedy_and_skips_what_does_not_fit(self):
        rows = [row("A", 6, "B1", date="1"), row("B", 6, "B1", date="2"), row("C", 4, "B1", date="3")]
        order = G.queue_order(rows)
        self.assertEqual(order, ["A", "B", "C"])
        res = G.evaluate(rows, *S10, selected=order)
        self.assertEqual([n for n in order if res[n]["ok"]], ["A", "C"])  # B skipped, C fits

    def test_queue_order_is_plan_date_then_creation_then_name(self):
        rows = [row("Z", 1, date="1", created="1"), row("A", 1, date="2", created="0"),
                row("C", 1, date="2", created="1"), row("B", 1, date="2", created="1")]
        self.assertEqual(G.queue_order(rows), ["Z", "A", "B", "C"])

    def test_blocked_selected_consumes_nothing(self):
        rows = [row("A", 12, "B1"), row("B", 6, "B1")]
        res = G.evaluate(rows, *S10, selected=["A", "B"])
        self.assertFalse(res["A"]["ok"])
        self.assertTrue(res["B"]["ok"])

    def test_unbatched_row_draws_item_pool_minus_earmarked(self):
        stock_b = {("I", WH, "B1"): 10, ("I", WH, "B2"): 5}
        rows = [row("A", 8, "B1"), row("B", 8)]
        res = G.evaluate(rows, {("I", WH): 15}, stock_b, {"I"}, selected=["A", "B"])
        self.assertTrue(res["A"]["ok"])
        self.assertFalse(res["B"]["ok"])
        self.assertEqual(res["B"]["shorts"][0]["available_when_its_turn"], 7)
        rows = [row("A", 8, "B1"), row("B", 7)]
        self.assertTrue(G.evaluate(rows, {("I", WH): 15}, stock_b, {"I"}, selected=["A", "B"])["B"]["ok"])

    def test_item_total_caps_even_when_batches_say_more(self):
        res = G.evaluate([row("A", 8, "B1")], {("I", WH): 5}, {("I", WH, "B1"): 10}, {"I"})
        self.assertFalse(res["A"]["ok"])
        self.assertEqual(res["A"]["shorts"][0]["available_when_its_turn"], 5)

    def test_exact_fit_is_ok(self):
        rows = [row("A", 4, "B1"), row("B", 6, "B1")]
        res = G.evaluate(rows, *S10, selected=["A", "B"])
        self.assertTrue(res["A"]["ok"] and res["B"]["ok"])

    def test_planned_batch_is_soft(self):
        stock_b = {("I", WH, "B1"): 4, ("I", WH, "B2"): 10}
        res = G.evaluate([row("A", 6, planned="B1")], {("I", WH): 14}, stock_b, {"I"})
        self.assertTrue(res["A"]["ok"])

    def test_two_rows_same_batch_in_one_transfer_sum(self):
        res = G.evaluate([row("A", 6, "B1"), row("A", 6, "B1")], *S10)
        self.assertFalse(res["A"]["ok"])
