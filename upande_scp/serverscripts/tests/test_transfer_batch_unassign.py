"""A batch put on a transfer row can be taken off again.

Once the panel had assigned a batch (or the rule had split a row over several), nothing
could undo it. ``clear_transfer_batches`` (and an empty pick in ``apply_transfer_batches``)
now unassign a row, fold a split row back into one, or clear the whole draft.

Run like test_transfer_batch_split.
"""

import unittest
from unittest import mock

import frappe

from upande_scp.serverscripts.store import store_keeper_api
from upande_scp.serverscripts.tests.test_transfer_batch_split import (
	BIG, ITEM, MINE, SMALL, _Draft,
)

API = "upande_scp.serverscripts.store.store_keeper_api."


class TestUnassign(_Draft):
	def _assigned_and_split(self):
		with self.holds((SMALL, 0.35, "2027-01-01"), (BIG, 7, None)):
			store_keeper_api.apply_transfer_batches(self.draft.name, frappe.as_json({"1": SMALL}))
		self.draft.reload()
		self.assertEqual([(r.batch_no, r.qty) for r in self.draft.items], [(SMALL, 0.35), (BIG, 0.7)])

	def test_unassign_a_single_row(self):
		with self.holds((BIG, 7, None)):
			store_keeper_api.apply_transfer_batches(self.draft.name, frappe.as_json({"1": BIG}))
		self.draft.reload()
		self.assertEqual(self.draft.items[0].batch_no, BIG)
		out = store_keeper_api.apply_transfer_batches(self.draft.name, frappe.as_json({"1": ""}))
		self.assertEqual(out["updated"], 1)
		self.draft.reload()
		self.assertEqual(len(self.draft.items), 1)
		self.assertFalse(self.draft.items[0].batch_no)
		self.assertFalse(self.draft.items[0].serial_and_batch_bundle)
		self.assertEqual(self.draft.items[0].qty, 1.05)

	def test_unassign_one_piece_of_a_split_row_merges_them_back(self):
		self._assigned_and_split()
		out = store_keeper_api.clear_transfer_batches(self.draft.name, frappe.as_json([2]))
		self.assertEqual(out["cleared"][0]["merged"], 1)
		self.draft.reload()
		self.assertEqual([(r.idx, r.batch_no, r.qty, r.transfer_qty) for r in self.draft.items],
		                 [(1, None, 1.05, 1.05)])

	def test_the_suggestion_is_offered_again_after_clearing(self):
		self._assigned_and_split()
		store_keeper_api.clear_transfer_batches(self.draft.name, frappe.as_json([1]))
		pool = {(ITEM, self.warehouse): [
			{"batch_no": BIG, "qty": 7, "expiry_date": None, "created": None}]}
		with mock.patch.object(store_keeper_api, "available_in_store", return_value=pool):
			out = store_keeper_api.suggest_transfer_batches(self.draft.name)
		row = out["rows"][0]
		self.assertFalse(row["settled"])
		self.assertEqual(row["suggestion"], BIG)

	def test_clear_all(self):
		self._assigned_and_split()
		out = store_keeper_api.clear_transfer_batches(self.draft.name)
		self.assertEqual(out["updated"], 1)
		self.draft.reload()
		self.assertEqual([(r.batch_no, r.qty) for r in self.draft.items], [(None, 1.05)])

	def test_clearing_an_unbatched_draft_is_a_no_op(self):
		out = store_keeper_api.clear_transfer_batches(self.draft.name)
		self.assertEqual(out, {"updated": 0, "cleared": []})

	def test_a_row_that_is_not_there_is_refused(self):
		with self.assertRaises(frappe.ValidationError):
			store_keeper_api.clear_transfer_batches(self.draft.name, frappe.as_json([9]))

	def test_a_submitted_entry_is_refused(self):
		self._assigned_and_split()
		frappe.db.set_value("Stock Entry", self.draft.name, "docstatus", 1)
		try:
			with self.assertRaises(frappe.ValidationError):
				store_keeper_api.clear_transfer_batches(self.draft.name)
			with self.assertRaises(frappe.ValidationError):
				store_keeper_api.apply_transfer_batches(self.draft.name, frappe.as_json({"1": ""}))
		finally:
			frappe.db.set_value("Stock Entry", self.draft.name, "docstatus", 0)
		self.draft.reload()
		self.assertEqual([(r.batch_no, r.qty) for r in self.draft.items], [(SMALL, 0.35), (BIG, 0.7)])


if __name__ == "__main__":
	unittest.main()
