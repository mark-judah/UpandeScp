"""What stops a transfer going out, and what must never stop it.

Three rules, and the difference between them is the whole point:

  * A batch that has EXPIRED blocks. The drum should not leave the store, and
    the storesman has to be told before he opens the draft, not after he has
    scanned his thumb.
  * A batch that is merely NEAR expiry does not block. It is the batch the rule
    wants issued first — that is what first-expiry-first-out means — and
    blocking it would leave the oldest stock on the shelf to actually expire.
  * A row with NO batch does not block either. Most rows arrive that way, and
    the system picks for them. Making a person choose thirty times a morning is
    how the migration placeholder got issued five thousand times.

And the flag that says "blocked" is derived from the transfer every time it is
read, never remembered. A checkbox that stays disabled after the storesman has
fixed the batch is worse than one that was never disabled.
"""

import unittest

import frappe
from frappe.utils import add_days, today

from upande_scp.serverscripts.store import store_keeper_api

ITEM = "_TEST GATING CHEMICAL"
GOOD = "_TEST-GATE-GOOD"
SOON = "_TEST-GATE-SOON"
DEAD = "_TEST-GATE-DEAD"


class BatchGatingCase(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")
		cls.warehouse = frappe.get_all(
			"Warehouse", filters={"is_group": 0, "disabled": 0}, pluck="name", limit=1
		)[0]
		cls.company = frappe.db.get_value("Warehouse", cls.warehouse, "company")

		if not frappe.db.exists("Item", ITEM):
			frappe.get_doc(
				{
					"doctype": "Item",
					"item_code": ITEM,
					"item_name": ITEM,
					"item_group": frappe.get_all(
						"Item Group", filters={"is_group": 0}, pluck="name"
					)[0],
					"stock_uom": "Litre" if frappe.db.exists("UOM", "Litre") else "Nos",
					"is_stock_item": 1,
					"has_batch_no": 1,
					"create_new_batch": 1,
					"batch_number_series": "_TGC-.#####",
				}
			).insert(ignore_permissions=True)

		# One healthy batch, one near the end of its life, one already gone.
		for batch_id, offset in ((GOOD, 400), (SOON, 9), (DEAD, -3)):
			if not frappe.db.exists("Batch", batch_id):
				frappe.get_doc(
					{
						"doctype": "Batch",
						"batch_id": batch_id,
						"item": ITEM,
						"expiry_date": add_days(today(), offset),
					}
				).insert(ignore_permissions=True)
		frappe.db.commit()

	def draft(self, batch_no=None):
		"""A one-row draft transfer, optionally already naming a batch."""
		doc = frappe.get_doc(
			{
				"doctype": "Stock Entry",
				"stock_entry_type": "Material Transfer for Manufacture",
				"company": self.company,
				"items": [
					{
						"item_code": ITEM,
						"qty": 1,
						"s_warehouse": self.warehouse,
						"t_warehouse": self.warehouse,
						"basic_rate": 10,
						"allow_zero_valuation_rate": 1,
					}
				],
			}
		)
		doc.insert(ignore_permissions=True)
		if batch_no:
			doc.items[0].db_set("batch_no", batch_no, update_modified=False)
			doc.reload()
		self.addCleanup(self._drop, doc.name)
		return doc

	@staticmethod
	def _drop(name):
		if frappe.db.exists("Stock Entry", name):
			frappe.delete_doc("Stock Entry", name, force=True, ignore_permissions=True)
		frappe.db.commit()


class TestWhatTheListSaysBeforeAnyoneOpensIt(BatchGatingCase):
	def test_an_expired_batch_is_reported_on_the_draft_itself(self):
		"""The icon on the row comes from this. A storesman should not have to
		open eight drafts to find the one he cannot send."""
		doc = self.draft(DEAD)
		health = store_keeper_api.batch_health([doc.name])
		self.assertEqual(health[doc.name]["expired"], 1)

	def test_a_batch_near_expiry_is_not_a_problem(self):
		"""FEFO issues the oldest first on purpose. Flagging it would mean the
		stock that is about to go off is the stock nobody is allowed to move."""
		doc = self.draft(SOON)
		health = store_keeper_api.batch_health([doc.name])
		self.assertEqual(health[doc.name]["expired"], 0)

	def test_a_row_with_no_batch_yet_is_not_a_problem_either(self):
		"""It is the normal state of a fresh transfer, and the system fills it."""
		doc = self.draft()
		health = store_keeper_api.batch_health([doc.name])
		self.assertEqual(health[doc.name]["expired"], 0)

	def test_a_healthy_batch_reports_nothing(self):
		doc = self.draft(GOOD)
		self.assertEqual(store_keeper_api.batch_health([doc.name])[doc.name]["expired"], 0)

	def test_it_answers_for_every_draft_asked_about_in_one_go(self):
		"""One query for the page, not one per row."""
		bad, fine = self.draft(DEAD), self.draft(GOOD)
		health = store_keeper_api.batch_health([bad.name, fine.name])
		self.assertEqual(health[bad.name]["expired"], 1)
		self.assertEqual(health[fine.name]["expired"], 0)

	def test_no_drafts_asks_nothing_of_the_database(self):
		self.assertEqual(store_keeper_api.batch_health([]), {})


class TestTheDraftListCarriesIt(BatchGatingCase):
	"""On a real listed draft, because `list_draft_transfers` joins Work Order
	and a synthetic transfer has none — the page would never show it."""

	def setUp(self):
		listed = store_keeper_api.list_draft_transfers()
		rows = listed.get("rows") or []
		if not rows:
			self.skipTest("no draft transfers on this site to borrow")
		# The first draft that actually has a batch-tracked row: a transfer of
		# chemicals nobody batches has nothing for this test to say.
		found = None
		for row in rows:
			hit = frappe.db.sql(
				"""SELECT sed.idx, COALESCE(sed.batch_no, '')
				   FROM `tabStock Entry Detail` sed
				   JOIN `tabItem` i ON i.name = sed.item_code AND i.has_batch_no = 1
				   WHERE sed.parent = %s ORDER BY sed.idx LIMIT 1""",
				row["name"],
			)
			if hit:
				found = (row["name"], hit[0])
				break
		if not found:
			self.skipTest("no draft on this site carries a batch-tracked row")
		self.draft_name, (self.row_idx, self.original) = found
		self.addCleanup(self._restore)

	def _restore(self):
		frappe.db.sql(
			"""UPDATE `tabStock Entry Detail` SET batch_no = %s
			   WHERE parent = %s AND idx = %s""",
			(self.original or None, self.draft_name, self.row_idx),
		)
		frappe.db.commit()

	def _put(self, batch_no):
		frappe.db.sql(
			"""UPDATE `tabStock Entry Detail` SET batch_no = %s
			   WHERE parent = %s AND idx = %s""",
			(batch_no, self.draft_name, self.row_idx),
		)
		frappe.db.commit()

	def _listed(self):
		listed = store_keeper_api.list_draft_transfers()
		return next(r for r in listed["rows"] if r["name"] == self.draft_name)

	def test_the_row_the_page_draws_says_whether_it_is_blocked(self):
		self._put(DEAD)
		row = self._listed()
		self.assertEqual(row["expired_batches"], 1)
		self.assertTrue(row["blocked"])

	def test_and_says_so_again_the_moment_it_is_fixed(self):
		"""The anti-stuck rule: blocked is read off the transfer every time the
		list is loaded, so replacing the batch clears it with no extra step and
		no second request to remember."""
		self._put(DEAD)
		self.assertTrue(self._listed()["blocked"])
		self._put(GOOD)
		row = self._listed()
		self.assertEqual(row["expired_batches"], 0)
		self.assertFalse(row["blocked"])


class TestReplacingAnExpiredBatch(BatchGatingCase):
	def test_an_expired_batch_can_be_replaced_without_clearing_it_first(self):
		"""Refusing to overwrite protects a decision someone made. An expired
		batch is not a decision worth protecting."""
		doc = self.draft(DEAD)
		store_keeper_api.apply_transfer_batches(doc.name, frappe.as_json({"1": GOOD}))
		doc.reload()
		self.assertEqual(doc.items[0].batch_no, GOOD)

	def test_a_batch_that_is_still_good_is_still_protected(self):
		doc = self.draft(GOOD)
		with self.assertRaises(Exception):
			store_keeper_api.apply_transfer_batches(doc.name, frappe.as_json({"1": SOON}))
		doc.reload()
		self.assertEqual(doc.items[0].batch_no, GOOD)


class TestTheSystemPicksSoNobodyHasTo(BatchGatingCase):
	"""Most rows reach the store with no batch at all, and a person choosing
	one thirty times a morning is how the migration placeholder got issued five
	thousand times. The submit fills the blanks itself, by the same rule the
	panel proposes with, and only stops for the two things a person must decide.
	"""

	def setUp(self):
		frappe.set_user("Administrator")
		self.stock = frappe.get_doc(
			{
				"doctype": "Stock Entry",
				"stock_entry_type": "Material Receipt",
				"company": self.company,
				"items": [
					{
						"item_code": ITEM,
						"qty": 5,
						"t_warehouse": self.warehouse,
						"batch_no": b,
						"use_serial_batch_fields": 1,
						"basic_rate": 10,
						"allow_zero_valuation_rate": 1,
					}
					for b in (GOOD, SOON)
				],
			}
		)
		self.stock.insert(ignore_permissions=True)
		self.stock.submit()
		frappe.db.commit()
		self.addCleanup(self._unstock)

	def _unstock(self):
		"""Tolerant on purpose: this runs twice in the test that takes the stock
		away itself, and a cleanup that fails would report a passing test as
		broken. The assertions above are the strict part."""
		self.stock.reload()
		if self.stock.docstatus == 1:
			try:
				self.stock.cancel()
			except Exception:
				frappe.db.rollback()
		frappe.db.commit()

	def test_a_blank_row_is_filled_by_the_rule_not_by_a_person(self):
		doc = self.draft()
		filled = store_keeper_api.autofill_batches(doc)
		self.assertEqual(len(filled), 1)
		# SOON expires first, so FEFO takes it — the near-expiry stock is what
		# should move, which is exactly why near expiry does not block.
		self.assertEqual(doc.items[0].batch_no, SOON)

	def test_it_marks_the_row_so_erpnext_honours_the_pick(self):
		doc = self.draft()
		store_keeper_api.autofill_batches(doc)
		self.assertEqual(int(doc.items[0].use_serial_batch_fields or 0), 1)

	def test_a_row_someone_already_chose_is_left_alone(self):
		doc = self.draft(GOOD)
		self.assertEqual(store_keeper_api.autofill_batches(doc), [])
		self.assertEqual(doc.items[0].batch_no, GOOD)

	def test_an_expired_batch_stops_it_and_says_which_row(self):
		doc = self.draft(DEAD)
		with self.assertRaises(frappe.ValidationError) as caught:
			store_keeper_api.autofill_batches(doc)
		said = str(caught.exception)
		self.assertIn(DEAD, said)
		self.assertIn(ITEM, said)

	def test_nothing_to_pick_stops_it_and_names_the_store(self):
		"""Not a silent half-fill: a transfer that looks answered and is not is
		worse than one that plainly refused."""
		self._unstock()  # take the stock away again
		doc = self.draft()
		with self.assertRaises(frappe.ValidationError) as caught:
			store_keeper_api.autofill_batches(doc)
		self.assertIn(self.warehouse, str(caught.exception))
