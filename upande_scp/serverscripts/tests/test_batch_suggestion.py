"""Choosing the batch so the storesman does not have to guess.

Batch tracking went on for 533 chemical items, and from that day a Material
Transfer for Manufacture could not be submitted until every outgoing row named a
batch. Nothing in SCP ever set one, so the work fell on the counter: open the
draft, open each row, read a list of near-identical codes, pick. The transfers
that went out often carried the wrong batch and the rest are still drafts.

The rule is not a judgement call — first-expiry-first-out, oldest stock breaking
the tie — so these tests pin the rule rather than the wiring. Everything here is
plain dicts: no warehouse, no ledger, no site.

Run:
    cd sites && ../env/bin/python -c "import frappe, unittest; \
        frappe.init(site='kaitet.local'); frappe.connect(); \
        from upande_scp.serverscripts.tests import test_batch_suggestion as T; \
        unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromModule(T))"
"""

import unittest

from upande_scp.serverscripts.store import batch_suggestion as BS

TODAY = "2026-09-21"


def b(code, qty, expiry=None, created=None):
	return {"batch_no": code, "qty": qty, "expiry_date": expiry, "created": created}


class TestTheOrderBatchesComeOut(unittest.TestCase):
	def test_the_one_expiring_soonest_goes_first(self):
		out = BS.rank_batches(
			[b("B-LATE", 10, "2027-01-01"), b("B-SOON", 10, "2026-10-01")], TODAY
		)
		self.assertEqual([x["batch_no"] for x in out], ["B-SOON", "B-LATE"])

	def test_same_expiry_issues_the_older_stock(self):
		out = BS.rank_batches(
			[
				b("B-NEW", 10, "2026-12-01", created="2026-08-01"),
				b("B-OLD", 10, "2026-12-01", created="2026-03-01"),
			],
			TODAY,
		)
		self.assertEqual([x["batch_no"] for x in out], ["B-OLD", "B-NEW"])

	def test_an_undated_batch_sorts_last_not_first(self):
		"""An undated batch is nearly always a data gap. Preferring it would drain
		the stock nobody recorded while the recorded stock goes off on the shelf."""
		out = BS.rank_batches([b("B-NODATE", 10), b("B-DATED", 10, "2027-06-01")], TODAY)
		self.assertEqual([x["batch_no"] for x in out], ["B-DATED", "B-NODATE"])

	def test_an_expired_batch_is_never_proposed(self):
		out = BS.rank_batches([b("B-GONE", 10, "2026-09-01"), b("B-OK", 10, "2027-01-01")], TODAY)
		self.assertEqual([x["batch_no"] for x in out], ["B-OK"])

	def test_a_batch_expiring_today_is_still_usable(self):
		out = BS.rank_batches([b("B-TODAY", 10, TODAY)], TODAY)
		self.assertEqual([x["batch_no"] for x in out], ["B-TODAY"])

	def test_an_empty_batch_is_not_offered(self):
		out = BS.rank_batches([b("B-EMPTY", 0, "2026-10-01"), b("B-HAS", 5, "2027-01-01")], TODAY)
		self.assertEqual([x["batch_no"] for x in out], ["B-HAS"])

	def test_negative_stock_is_not_offered_either(self):
		self.assertEqual(BS.rank_batches([b("B-NEG", -4, "2026-10-01")], TODAY), [])

	def test_the_order_is_stable_across_two_runs(self):
		"""The same draft must suggest the same thing twice, or the storesman
		cannot tell a real change from a reshuffle."""
		rows = [b("B-B", 5, "2026-12-01"), b("B-A", 5, "2026-12-01")]
		self.assertEqual(
			[x["batch_no"] for x in BS.rank_batches(rows, TODAY)],
			[x["batch_no"] for x in BS.rank_batches(list(reversed(rows)), TODAY)],
		)

	def test_junk_in_the_list_does_not_take_the_suggestion_down(self):
		out = BS.rank_batches([None, {}, b("", 5), b("B-OK", 5, "2027-01-01")], TODAY)
		self.assertEqual([x["batch_no"] for x in out], ["B-OK"])


class TestFillingARow(unittest.TestCase):
	def test_one_batch_covers_it(self):
		out = BS.allocate(20, [b("B1", 50, "2026-12-01")], TODAY)
		self.assertEqual(out["picks"], [{"batch_no": "B1", "qty": 20, "expiry_date": "2026-12-01"}])
		self.assertEqual(out["short"], 0)

	def test_it_spills_into_the_next_batch_in_order(self):
		out = BS.allocate(
			30, [b("B-LATE", 50, "2027-01-01"), b("B-SOON", 20, "2026-10-01")], TODAY
		)
		self.assertEqual([(p["batch_no"], p["qty"]) for p in out["picks"]],
		                 [("B-SOON", 20), ("B-LATE", 10)])
		self.assertEqual(out["short"], 0)

	def test_a_shortfall_is_reported_rather_than_hidden(self):
		"""A row that looks answered but is not is worse than one visibly short."""
		out = BS.allocate(100, [b("B1", 30, "2026-12-01")], TODAY)
		self.assertEqual(out["allocated"], 30)
		self.assertEqual(out["short"], 70)

	def test_nothing_available_at_all(self):
		out = BS.allocate(10, [], TODAY)
		self.assertEqual(out["picks"], [])
		self.assertEqual(out["short"], 10)

	def test_it_stops_once_the_row_is_covered(self):
		out = BS.allocate(5, [b("B1", 10, "2026-11-01"), b("B2", 10, "2026-12-01")], TODAY)
		self.assertEqual(len(out["picks"]), 1)

	def test_float_crumbs_do_not_read_as_short(self):
		out = BS.allocate(0.3, [b("B1", 0.1, "2026-11-01"), b("B2", 0.2, "2026-12-01")], TODAY)
		self.assertEqual(out["short"], 0.0)

	def test_a_row_asking_for_nothing_asks_for_nothing(self):
		out = BS.allocate(0, [b("B1", 10, "2026-11-01")], TODAY)
		self.assertEqual(out["picks"], [])
		self.assertEqual(out["short"], 0)


class TestWhatThePanelShows(unittest.TestCase):
	def test_days_are_counted_both_ways(self):
		self.assertEqual(BS.days_until("2026-09-30", TODAY), 9)
		self.assertEqual(BS.days_until("2026-09-11", TODAY), -10)
		self.assertEqual(BS.days_until(TODAY, TODAY), 0)

	def test_an_undated_batch_has_no_countdown(self):
		self.assertIsNone(BS.days_until(None, TODAY))
		self.assertIsNone(BS.days_until("not a date", TODAY))

	def test_the_single_word_the_row_is_coloured_by(self):
		self.assertEqual(BS.describe(b("B", 5, "2027-06-01"), TODAY)["status"], "ok")
		self.assertEqual(BS.describe(b("B", 5, "2026-10-05"), TODAY)["status"], "expiring")
		self.assertEqual(BS.describe(b("B", 5, "2026-09-01"), TODAY)["status"], "expired")
		self.assertEqual(BS.describe(b("B", 5), TODAY)["status"], "undated")

	def test_thirty_days_is_still_a_warning_and_thirty_one_is_not(self):
		self.assertEqual(BS.describe(b("B", 5, "2026-10-21"), TODAY)["status"], "expiring")
		self.assertEqual(BS.describe(b("B", 5, "2026-10-22"), TODAY)["status"], "ok")

	def test_the_panel_carries_the_numbers_behind_the_suggestion(self):
		d = BS.describe(b("B-1", 12.5, "2026-10-01"), TODAY)
		self.assertEqual(d["batch_no"], "B-1")
		self.assertEqual(d["qty"], 12.5)
		self.assertEqual(d["days_to_expiry"], 10)


class TestTheMigrationPlaceholders(unittest.TestCase):
	"""`-PREMIGRATION` batches are opening stock the migration invented.

	On live there are 1,971 of them holding 2.87 trillion units between them.
	Because they never run out they win any rule that merely asks whether there
	is enough — and they did: in the forty-five days before this was written,
	every transfer row that carried a batch carried one of these. 5,213 rows,
	not one real batch. That is what "we have not had the correct batch numbers"
	turned out to mean, so the rule has to name them rather than hope the dates
	sort them out.
	"""

	def test_a_real_batch_is_preferred_however_little_is_left(self):
		out = BS.rank_batches(
			[b("1111133076-PREMIGRATION", 999999880, created="2026-09-15"),
			 b("ROSE-2026-00033", 2.95, created="2026-09-03")],
			TODAY,
		)
		self.assertEqual([x["batch_no"] for x in out],
		                 ["ROSE-2026-00033", "1111133076-PREMIGRATION"])

	def test_it_wins_even_against_a_sooner_expiry(self):
		"""Expiry is the rule among real stock. A placeholder's expiry is fiction,
		so it must not be able to jump the queue with one."""
		out = BS.rank_batches(
			[b("X-PREMIGRATION", 1000, "2026-10-01"), b("ROSE-1", 5, "2027-06-01")],
			TODAY,
		)
		self.assertEqual([x["batch_no"] for x in out], ["ROSE-1", "X-PREMIGRATION"])

	def test_it_is_still_offered_when_it_is_all_there_is(self):
		"""Not hidden: sometimes the placeholder really is all the store has on
		the system, and refusing to show it would just move the block."""
		out = BS.rank_batches([b("X-PREMIGRATION", 1000)], TODAY)
		self.assertEqual([x["batch_no"] for x in out], ["X-PREMIGRATION"])

	def test_real_stock_is_used_first_and_the_placeholder_takes_the_rest(self):
		plan = BS.allocate(
			10, [b("X-PREMIGRATION", 9999, created="2026-09-15"),
			     b("ROSE-1", 4, created="2026-09-03")], TODAY,
		)
		self.assertEqual([(p["batch_no"], p["qty"]) for p in plan["picks"]],
		                 [("ROSE-1", 4), ("X-PREMIGRATION", 6)])
		self.assertEqual(plan["short"], 0)

	def test_the_panel_says_what_it_is(self):
		d = BS.describe(b("1111133076-PREMIGRATION", 999999880), TODAY)
		self.assertEqual(d["status"], "placeholder")
		self.assertTrue(d["placeholder"])

	def test_placeholder_beats_every_other_label(self):
		"""Even a dated, healthy-looking placeholder reads as a placeholder — its
		expiry is as invented as its quantity."""
		self.assertEqual(BS.describe(b("X-PREMIGRATION", 5, "2027-06-01"), TODAY)["status"],
		                 "placeholder")

	def test_a_real_batch_is_not_mistaken_for_one(self):
		self.assertFalse(BS.is_placeholder("ROSE-2026-00033"))
		self.assertFalse(BS.is_placeholder(""))
		self.assertFalse(BS.is_placeholder(None))

	def test_the_match_ignores_case(self):
		self.assertTrue(BS.is_placeholder("abc-premigration"))
