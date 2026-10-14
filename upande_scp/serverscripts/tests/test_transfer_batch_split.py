"""A row the store covers from several batches leaves as several rows.

FEFO reaches for the small, nearly empty batch first. A Stock Entry row carries
one batch, and only the first was ever written — over the whole quantity — so
ERPNext refused the submit for want of stock in that batch and the transfer
rolled back. On live that was 81 of the 254 stuck spray transfers.

kaitet.local holds no batched stock, so the store's holdings are patched in:
these tests pin what is written to the draft, not ERPNext's ledger.

Run:
    cd sites && ../env/bin/python -c "import frappe, unittest; \\
        frappe.init(site='kaitet.local'); frappe.connect(); \\
        from upande_scp.serverscripts.tests import test_transfer_batch_split as T; \\
        unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromModule(T))"
"""

import unittest
from unittest import mock

import frappe

from upande_scp.serverscripts.store import store_keeper_api

ITEM = "_TEST TRANSFER SPLIT CHEMICAL"
SMALL, BIG, MINE = "_TEST-TS-SMALL", "_TEST-TS-BIG", "_TEST-TS-MINE"


class _Draft(unittest.TestCase):
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
					"batch_number_series": "_TTS-.#####",
				}
			).insert(ignore_permissions=True)
		for code in (SMALL, BIG, MINE):
			if not frappe.db.exists("Batch", code):
				frappe.get_doc({"doctype": "Batch", "batch_id": code, "item": ITEM}).insert(
					ignore_permissions=True
				)
		frappe.db.commit()

	def setUp(self):
		self.draft = frappe.get_doc(
			{
				"doctype": "Stock Entry",
				"stock_entry_type": "Material Transfer for Manufacture",
				"company": self.company,
				"items": [
					{
						"item_code": ITEM,
						"qty": 1.05,
						"s_warehouse": self.warehouse,
						"t_warehouse": self.warehouse,
						"basic_rate": 10,
						"allow_zero_valuation_rate": 1,
					}
				],
			}
		).insert(ignore_permissions=True)

	def tearDown(self):
		frappe.delete_doc("Stock Entry", self.draft.name, force=True, ignore_permissions=True)
		frappe.db.commit()

	def holds(self, *batches):
		"""Patch what the store holds: (batch, qty, expiry)."""
		pool = {
			(ITEM, self.warehouse): [
				{"batch_no": b, "qty": q, "expiry_date": e, "created": None}
				for b, q, e in batches
			]
		}
		return mock.patch.object(store_keeper_api, "available_in_store", return_value=pool)


class TestSubmitFillsAndSplits(_Draft):
	def test_a_row_spanning_two_batches_becomes_two_rows(self):
		with self.holds((SMALL, 0.35, "2027-01-01"), (BIG, 7, None)):
			filled = store_keeper_api.autofill_batches(self.draft)
		rows = [(r.idx, r.batch_no, r.qty, r.use_serial_batch_fields) for r in self.draft.items]
		self.assertEqual(rows, [(1, SMALL, 0.35, 1), (2, BIG, 0.7, 1)])
		self.assertEqual(len(filled), 2)
		# the copy is the same line in every other respect
		self.assertEqual(self.draft.items[1].s_warehouse, self.warehouse)
		self.assertEqual(self.draft.items[1].item_code, ITEM)

	def test_the_split_draft_saves(self):
		with self.holds((SMALL, 0.35, "2027-01-01"), (BIG, 7, None)):
			store_keeper_api.autofill_batches(self.draft)
		self.draft.save(ignore_permissions=True)
		self.draft.reload()
		self.assertEqual([(r.batch_no, r.qty) for r in self.draft.items], [(SMALL, 0.35), (BIG, 0.7)])

	def test_one_batch_that_covers_it_leaves_one_row(self):
		with self.holds((BIG, 7, None)):
			store_keeper_api.autofill_batches(self.draft)
		self.assertEqual([(r.batch_no, r.qty) for r in self.draft.items], [(BIG, 1.05)])

	def test_a_store_that_cannot_cover_the_row_refuses_by_name(self):
		with self.holds((SMALL, 0.35, "2027-01-01")):
			with self.assertRaises(frappe.ValidationError) as ctx:
				store_keeper_api.autofill_batches(self.draft)
		self.assertIn("holds only 0.35", str(ctx.exception))
		self.assertFalse(self.draft.items[0].batch_no, "nothing half-written")


class TestApplySplitsBehindTheChosenBatch(_Draft):
	def test_the_chosen_batch_goes_first_and_the_rule_covers_the_rest(self):
		with self.holds((BIG, 7, None), (MINE, 0.5, None)):
			out = store_keeper_api.apply_transfer_batches(
				self.draft.name, frappe.as_json({"1": MINE})
			)
		self.draft.reload()
		self.assertEqual([(r.batch_no, r.qty) for r in self.draft.items], [(MINE, 0.5), (BIG, 0.55)])
		self.assertEqual(out["split"], [{"item_code": ITEM, "batches": [MINE, BIG]}])

	def test_a_chosen_batch_with_no_stock_here_is_refused(self):
		with self.holds((BIG, 7, None)):
			with self.assertRaises(frappe.ValidationError):
				store_keeper_api.apply_transfer_batches(
					self.draft.name, frappe.as_json({"1": MINE})
				)
		self.draft.reload()
		self.assertFalse(self.draft.items[0].batch_no)


class _FakeSE:
	"""Just enough of a Stock Entry for the submit loop."""

	def __init__(self, name, fail=False):
		self.name, self.fail = name, fail
		self.docstatus, self.purpose = 0, store_keeper_api._SE_PURPOSE
		self.bio_employee = self.bio_employee_name = "EMP-1"
		self.flags = frappe._dict()
		self.items = []

	def save(self, **kw):
		pass

	def submit(self):
		if self.fail:
			raise frappe.ValidationError("no stock in batch")


class TestOneFailureKeepsTheOthers(unittest.TestCase):
	def test_each_success_is_committed_before_the_next_transfer_runs(self):
		docs = {"SE-1": _FakeSE("SE-1"), "SE-2": _FakeSE("SE-2", fail=True), "SE-3": _FakeSE("SE-3")}
		calls = []
		scan = {"employee": "EMP-1", "employee_name": "E", "biometric_id": "1", "name": "LOG-1"}
		with mock.patch.object(store_keeper_api, "_check_perm"), \
			mock.patch.object(store_keeper_api, "_latest_biometric_log", return_value=scan), \
			mock.patch.object(store_keeper_api, "autofill_batches", return_value=[]), \
			mock.patch.object(store_keeper_api.frappe, "get_doc", side_effect=lambda dt, n: docs[n]), \
			mock.patch.object(store_keeper_api, "now_datetime", return_value="2026-01-01 00:00:00"), \
			mock.patch.object(store_keeper_api, "_real_docstatus", side_effect=lambda n: 0 if n == "SE-2" else 1), \
			mock.patch.object(store_keeper_api.frappe.db, "commit", side_effect=lambda: calls.append("commit")), \
			mock.patch.object(store_keeper_api.frappe.db, "rollback", side_effect=lambda: calls.append("rollback")):
			out = store_keeper_api.submit_with_biometric(frappe.as_json(["SE-1", "SE-2", "SE-3"]))
		self.assertEqual((out["ok"], out["failed"]), (2, 1))
		# SE-1 is committed before SE-2's rollback can reach it
		self.assertEqual(calls[:3], ["commit", "rollback", "commit"])


class TestAChunkedSubmitKeepsItsScan(unittest.TestCase):
	"""Thirty transfers in one request ran past the server's timeout, so the page
	sends a few at a time — but the scan is only fresh for three minutes on live.
	The first call opens a run for exactly the selection; chunks quote it."""

	SCAN = {"employee": "EMP-1", "employee_name": "E", "biometric_id": "1", "name": "LOG-1"}

	def _run(self, *names):
		with mock.patch.object(store_keeper_api, "_check_perm"), \
			mock.patch.object(store_keeper_api, "_latest_biometric_log", return_value=self.SCAN):
			return store_keeper_api.begin_biometric_submit(frappe.as_json(list(names)))["run"]

	def _chunk(self, names, run):
		docs = {n: _FakeSE(n) for n in names}
		with mock.patch.object(store_keeper_api, "_check_perm"), \
			mock.patch.object(store_keeper_api, "_latest_biometric_log", return_value=None), \
			mock.patch.object(store_keeper_api, "autofill_batches", return_value=[]), \
			mock.patch.object(store_keeper_api.frappe, "get_doc", side_effect=lambda dt, n: docs[n]), \
			mock.patch.object(store_keeper_api, "now_datetime", return_value="2026-01-01 00:00:00"), \
			mock.patch.object(store_keeper_api, "_real_docstatus", side_effect=lambda n: 0 if n == "SE-2" else 1), \
			mock.patch.object(store_keeper_api.frappe.db, "commit"), \
			mock.patch.object(store_keeper_api.frappe.db, "rollback"):
			return store_keeper_api.submit_with_biometric(frappe.as_json(names), run=run)

	def test_a_later_chunk_needs_no_new_scan(self):
		run = self._run("SE-1", "SE-2", "SE-3")
		out = self._chunk(["SE-3"], run)  # no fresh scan exists by now
		self.assertEqual(out["ok"], 1)
		self.assertEqual(out["scanned"]["employee"], "EMP-1")

	def test_ok_needs_the_database_to_say_submitted(self):
		docs = {"SE-1": _FakeSE("SE-1")}
		scan = {"employee": "EMP-1", "employee_name": "E", "biometric_id": "1", "name": "LOG-1"}
		with mock.patch.object(store_keeper_api, "_check_perm"), \
			mock.patch.object(store_keeper_api, "_latest_biometric_log", return_value=scan), \
			mock.patch.object(store_keeper_api, "autofill_batches", return_value=[]), \
			mock.patch.object(store_keeper_api.frappe, "get_doc", side_effect=lambda dt, n: docs[n]), \
			mock.patch.object(store_keeper_api, "now_datetime", return_value="2026-01-01 00:00:00"), \
			mock.patch.object(store_keeper_api, "_real_docstatus", return_value=0), \
			mock.patch.object(store_keeper_api.frappe.db, "commit"), \
			mock.patch.object(store_keeper_api.frappe.db, "rollback"):
			out = store_keeper_api.submit_with_biometric(frappe.as_json(["SE-1"]))
		self.assertEqual((out["ok"], out["failed"]), (0, 1))
		self.assertEqual(out["results"][0]["docstatus"], 0)

	def test_the_run_covers_only_what_was_scanned_for(self):
		run = self._run("SE-1")
		with self.assertRaises(frappe.PermissionError):
			self._chunk(["SE-9"], run)

	def test_an_unknown_run_is_refused(self):
		with self.assertRaises(frappe.ValidationError):
			self._chunk(["SE-1"], "not-a-run")

	def test_without_a_run_a_fresh_scan_is_still_required(self):
		with self.assertRaises(frappe.ValidationError):
			self._chunk(["SE-1"], None)
