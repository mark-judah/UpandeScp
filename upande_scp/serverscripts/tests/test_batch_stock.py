"""What the store holds, batch by batch — whichever way the site records it.

ERPNext keeps batch stock two different ways. The modern one is a Serial and
Batch Bundle hanging off the ledger entry; the older one is a `batch_no` written
straight onto the entry, which is what a row with `use_serial_batch_fields`
produces — and that is the shape everything on mona is written in, because that
is what makes ERPNext honour a batch somebody chose.

The query behind the picker reads bundles. The question these tests answer is
whether that is enough HERE: a receipt written the legacy way still gets a
bundle built for it on submit, so the picker sees the stock either way. Worth
pinning rather than assuming, because the alternative failure is silent — an
empty batch list with the drums plainly on the shelf.
"""

import unittest

import frappe

from upande_scp.serverscripts.store.batch_stock import available_in_store

ITEM = "_TEST BATCH STOCK CHEMICAL"
BATCH = "_TEST-BATCH-STOCK-A"
WAREHOUSE_NAME = "_Test Batch Store"


class TestAvailableInStore(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")
		cls.company = frappe.get_all("Company", pluck="name")[0]
		cls.abbr = frappe.db.get_value("Company", cls.company, "abbr")
		cls.warehouse = f"{WAREHOUSE_NAME} - {cls.abbr}"

		if not frappe.db.exists("Warehouse", cls.warehouse):
			frappe.get_doc(
				{
					"doctype": "Warehouse",
					"warehouse_name": WAREHOUSE_NAME,
					"company": cls.company,
					"is_group": 0,
				}
			).insert(ignore_permissions=True)

		if not frappe.db.exists("Item", ITEM):
			frappe.get_doc(
				{
					"doctype": "Item",
					"item_code": ITEM,
					"item_name": ITEM,
					"item_group": frappe.get_all("Item Group", filters={"is_group": 0}, pluck="name")[0],
					"stock_uom": "Litre" if frappe.db.exists("UOM", "Litre") else "Nos",
					"is_stock_item": 1,
					"has_batch_no": 1,
					"create_new_batch": 1,
					"batch_number_series": "_TBS-.#####",
				}
			).insert(ignore_permissions=True)

		if not frappe.db.exists("Batch", BATCH):
			frappe.get_doc(
				{"doctype": "Batch", "batch_id": BATCH, "item": ITEM}
			).insert(ignore_permissions=True)

		cls.receipt = frappe.get_doc(
			{
				"doctype": "Stock Entry",
				"stock_entry_type": "Material Receipt",
				"company": cls.company,
				"items": [
					{
						"item_code": ITEM,
						"qty": 7,
						"t_warehouse": cls.warehouse,
						"batch_no": BATCH,
						"use_serial_batch_fields": 1,
						"basic_rate": 10,
						"allow_zero_valuation_rate": 1,
					}
				],
			}
		)
		cls.receipt.insert(ignore_permissions=True)
		cls.receipt.submit()
		frappe.db.commit()

	@classmethod
	def tearDownClass(cls):
		cls.receipt.reload()
		if cls.receipt.docstatus == 1:
			cls.receipt.cancel()
		frappe.db.commit()

	def test_it_finds_stock_recorded_the_legacy_way(self):
		"""The bundle-only query answered nothing here, and the picker said the
		shelf was empty while seven litres sat on it."""
		found = available_in_store([(ITEM, self.warehouse)])
		rows = found.get((ITEM, self.warehouse)) or []
		self.assertTrue(rows, "no batch found for stock that is plainly there")
		self.assertEqual(rows[0]["batch_no"], BATCH)
		self.assertEqual(rows[0]["qty"], 7.0)

	def test_it_counts_the_quantity_once(self):
		"""A ledger entry carrying both a bundle and a batch_no must not be
		read twice — the row would claim double what the store has."""
		total = sum(
			r["qty"]
			for r in (available_in_store([(ITEM, self.warehouse)]).get((ITEM, self.warehouse)) or [])
			if r["batch_no"] == BATCH
		)
		self.assertEqual(total, 7.0)

	def test_a_warehouse_with_nothing_in_it_answers_empty(self):
		self.assertEqual(available_in_store([(ITEM, "_no such warehouse")]), {})

	def test_no_pairs_asks_nothing_of_the_database(self):
		self.assertEqual(available_in_store([]), {})


class TestTheChosenBatchIsTheOneThatLeaves(unittest.TestCase):
	"""Naming a batch on the row is not enough.

	With Stock Settings' `auto_create_serial_and_batch_bundle_for_outward` on —
	the default here — ERPNext builds its own bundle for every outgoing row by
	its own FIFO rule, and then refuses the submit outright:

	    At row 1: Serial and Batch Bundle ... has already created.
	    Please remove the values from the serial no or batch no fields.

	So the storesman's pick would either be overruled or stop the transfer
	leaving at all. `use_serial_batch_fields` is what settles it, and this is
	the test that says so — it was found by submitting a real transfer with a
	deliberately non-FEFO batch and reading the ledger afterwards.

	Not a version difference: both benches run v16, and ERPNext's own
	`set_use_serial_batch_fields` is never called on a Stock Entry, so a row
	from `make_stock_entry(work_order)` starts at 0 wherever it is built.
	"""

	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")

	def test_applying_a_batch_marks_the_row_so_erpnext_honours_it(self):
		"""Behaviour, not a grep: apply a batch through the endpoint and read
		what the row says afterwards."""
		from upande_scp.serverscripts.store import store_keeper_api

		company = frappe.get_all("Company", pluck="name")[0]
		abbr = frappe.db.get_value("Company", company, "abbr")
		warehouse = f"{WAREHOUSE_NAME} - {abbr}"

		draft = frappe.get_doc(
			{
				"doctype": "Stock Entry",
				"stock_entry_type": "Material Transfer for Manufacture",
				"company": company,
				"items": [
					{
						"item_code": ITEM,
						"qty": 1,
						"s_warehouse": warehouse,
						"t_warehouse": warehouse,
						"basic_rate": 10,
						"allow_zero_valuation_rate": 1,
					}
				],
			}
		)
		draft.insert(ignore_permissions=True)
		try:
			store_keeper_api.apply_transfer_batches(
				draft.name, frappe.as_json({"1": BATCH})
			)
			draft.reload()
			row = draft.items[0]
			self.assertEqual(row.batch_no, BATCH)
			self.assertEqual(
				int(row.use_serial_batch_fields or 0),
				1,
				"without this ERPNext builds its own bundle by FIFO and refuses "
				"the submit, so the storesman's pick never leaves the store",
			)
		finally:
			draft.reload()
			if draft.docstatus == 0:
				draft.delete(ignore_permissions=True)
			frappe.db.commit()
