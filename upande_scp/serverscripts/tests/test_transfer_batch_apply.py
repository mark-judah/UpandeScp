"""Naming a batch on the row is not enough to issue it.

`apply_transfer_batches` wrote `batch_no` and stopped there, which reads as
correct and is not. With Stock Settings'
`auto_create_serial_and_batch_bundle_for_outward` on — which it is here and on
live — ERPNext builds its own Serial and Batch Bundle for every outgoing row by
its own FIFO rule, and then refuses the submit outright:

    At row 1: Serial and Batch Bundle ... has already created.
    Please remove the values from the serial no or batch no fields.

So the batch the storesman chose is either replaced by ERPNext's own or the
transfer never leaves the store. Measured on kaitet.local against a real
transfer: written the old way the submit was REFUSED with exactly that message;
with `use_serial_batch_fields` set, it submitted and the ledger consumed the
batch that was chosen — including one deliberately picked against FEFO, so the
ledger could not have arrived at it by the default rule.

Nothing else sets the flag for a transfer built here.
`StockController.set_use_serial_batch_fields` would copy it off Stock Settings,
but no Stock Entry path calls that method, and a row from
`make_stock_entry(work_order)` arrives at 0. Live has no batch row with the flag
off, so the desk path sets it there — a transfer batched only through the store
page was never covered.
"""

import unittest

import frappe

from upande_scp.serverscripts.store import store_keeper_api

ITEM = "_TEST TRANSFER BATCH CHEMICAL"
BATCH = "_TEST-TB-A"


class TestApplyMarksTheRow(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")
		# An existing store, not one made here: Warehouse on this site carries a
		# mandatory custom field (custom_farm), and a test that has to satisfy
		# the farm's own master data is a test about the wrong thing.
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
					"batch_number_series": "_TTB-.#####",
				}
			).insert(ignore_permissions=True)

		if not frappe.db.exists("Batch", BATCH):
			frappe.get_doc(
				{"doctype": "Batch", "batch_id": BATCH, "item": ITEM}
			).insert(ignore_permissions=True)
		frappe.db.commit()

	def test_the_batch_is_written_in_the_form_erpnext_will_honour(self):
		draft = frappe.get_doc(
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
		draft.insert(ignore_permissions=True)
		try:
			self.assertEqual(
				int(draft.items[0].use_serial_batch_fields or 0),
				0,
				"a fresh row starts at 0 — if that changes, this fix is redundant",
			)
			store_keeper_api.apply_transfer_batches(
				draft.name, frappe.as_json({"1": BATCH})
			)
			draft.reload()
			row = draft.items[0]
			self.assertEqual(row.batch_no, BATCH)
			self.assertEqual(
				int(row.use_serial_batch_fields or 0),
				1,
				"without this ERPNext re-picks the batch by FIFO and refuses the "
				"submit, so the storesman's choice never leaves the store",
			)
		finally:
			# force: a draft on this site still trips the GL link check on
			# delete, and leaving stock entries behind in a test is worse.
			frappe.delete_doc(
				"Stock Entry", draft.name, force=True, ignore_permissions=True
			)
			frappe.db.commit()
