"""Reservation, gate, stale-plan and store-keeper batch paths against REAL ERPNext
batching: a has_batch_no chemical, real Batch docs, a Material Receipt into a real
store mapped to a Farm, real Application Floor Plan work orders.

The other reservation tests mock the ledger. This one proves the same code against
the bundle join (`available_in_store`), the Bin and a submitted Stock Entry.

stop_stale_plans and the stock entry path commit, so a rollback cannot clean up
after them. Instead everything is created under unique names and removed by SQL in
tearDownClass (ledger rows, bundles, bins, GL, stock entries, work orders, batches,
item, warehouse), leaving the site as it was found.
"""

import unittest

import frappe
from frappe.utils import add_days, add_to_date, now_datetime, today

from upande_scp.serverscripts.spray_plan_creator import reservations as R
from upande_scp.serverscripts.store import store_keeper_api

ITEM = "_TEST RB CHEMICAL"
B1 = "_TEST-RB-B1"   # expires first (FEFO winner)
B2 = "_TEST-RB-B2"
B3 = "_TEST-RB-B3"   # exists, never stocked
STORE = "_TEST RB Store"
COMPANY = "Karen Roses"


def _afp_template():
	"""Reuse a real BOM's production item so ERPNext's Work Order validation is
	satisfied; the test then overwrites required_items with its own chemical."""
	return frappe.db.get_value(
		"BOM", {"docstatus": 1, "is_active": 1, "company": COMPANY},
		["name", "item"], as_dict=True,
	)


class RealBatchCase(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")
		cls.wos = []
		cls.entries = []
		cls._wipe()  # a crashed earlier run must not poison this one

		cls.farm = frappe.get_all("Farm", pluck="name", limit=1)[0]
		cls.bom = _afp_template()
		cls.abbr = frappe.db.get_value("Company", COMPANY, "abbr")
		cls.wip = frappe.get_all(
			"Warehouse", filters={"company": COMPANY, "is_group": 0, "disabled": 0}, pluck="name", limit=1
		)[0]

		wh = frappe.get_doc({
			"doctype": "Warehouse", "warehouse_name": STORE, "company": COMPANY,
			"custom_farm": cls.farm,
		}).insert(ignore_permissions=True)
		cls.store = wh.name

		frappe.get_doc({
			"doctype": "Item", "item_code": ITEM, "item_name": ITEM,
			"item_group": frappe.get_all("Item Group", filters={"is_group": 0}, pluck="name")[0],
			"stock_uom": "Litre" if frappe.db.exists("UOM", "Litre") else "Nos",
			"is_stock_item": 1, "has_batch_no": 1, "create_new_batch": 0,
		}).insert(ignore_permissions=True)

		for b, days in ((B1, 30), (B2, 200), (B3, 100)):
			frappe.get_doc({"doctype": "Batch", "batch_id": b, "item": ITEM,
							"expiry_date": add_days(today(), days)}).insert(ignore_permissions=True)

		cls.receipt = frappe.get_doc({
			"doctype": "Stock Entry", "stock_entry_type": "Material Receipt", "company": COMPANY,
			"items": [
				{"item_code": ITEM, "qty": q, "t_warehouse": cls.store, "batch_no": b,
				 "use_serial_batch_fields": 1, "basic_rate": 10}
				for b, q in ((B1, 10), (B2, 20))
			],
		})
		cls.receipt.insert(ignore_permissions=True)
		cls.receipt.submit()
		frappe.db.commit()

	@classmethod
	def tearDownClass(cls):
		cls._wipe()

	@classmethod
	def _wipe(cls):
		"""Remove every row this module can have created. Keyed on the test item,
		store and the work orders carrying the test item."""
		wos = frappe.db.sql_list(
			"SELECT DISTINCT parent FROM `tabWork Order Item` WHERE item_code=%s", ITEM)
		ses = set(frappe.db.sql_list(
			"SELECT DISTINCT parent FROM `tabStock Entry Detail` WHERE item_code=%s", ITEM))
		if wos:
			ses |= set(frappe.db.sql_list(
				"SELECT name FROM `tabStock Entry` WHERE work_order IN %s", (wos,)))
		bundles = frappe.db.sql_list(
			"SELECT name FROM `tabSerial and Batch Bundle` WHERE item_code=%s", ITEM)
		if bundles:
			frappe.db.sql("DELETE FROM `tabSerial and Batch Entry` WHERE parent IN %s", (bundles,))
			frappe.db.sql("DELETE FROM `tabSerial and Batch Bundle` WHERE name IN %s", (bundles,))
		for t in ("Stock Ledger Entry", "Bin"):
			frappe.db.sql(f"DELETE FROM `tab{t}` WHERE item_code=%s", ITEM)
		if ses:
			frappe.db.sql("DELETE FROM `tabStock Ledger Entry` WHERE voucher_no IN %s", (list(ses),))
			frappe.db.sql("DELETE FROM `tabGL Entry` WHERE voucher_no IN %s", (list(ses),))
			frappe.db.sql("DELETE FROM `tabStock Entry Detail` WHERE parent IN %s", (list(ses),))
			frappe.db.sql("DELETE FROM `tabStock Entry` WHERE name IN %s", (list(ses),))
		if wos:
			for t in ("Work Order Item", "Work Order Operation"):
				frappe.db.sql(f"DELETE FROM `tab{t}` WHERE parent IN %s", (wos,))
			frappe.db.sql("DELETE FROM `tabWork Order` WHERE name IN %s", (wos,))
			frappe.db.sql(
				"DELETE FROM `tabComment` WHERE reference_doctype='Work Order' AND reference_name IN %s", (wos,))
		frappe.db.sql("DELETE FROM `tabBatch` WHERE item=%s", ITEM)
		frappe.db.sql("DELETE FROM `tabItem Default` WHERE parent=%s", ITEM)
		frappe.db.sql("DELETE FROM `tabItem` WHERE name=%s", ITEM)
		frappe.db.sql("DELETE FROM `tabWarehouse` WHERE warehouse_name=%s", STORE)
		frappe.db.commit()

	# -- builders -----------------------------------------------------------------

	def plan(self, qty, batch=None, planned=None, state="Pending Submission", submit=False,
			 skip_gate=False):
		"""A real AFP work order requesting `qty` of the chemical from the store."""
		doc = frappe.get_doc({
			"doctype": "Work Order", "company": COMPANY, "production_item": self.bom.item,
			"bom_no": self.bom.name, "qty": 1, "custom_type": R.AFP,
			"fg_warehouse": self.wip, "wip_warehouse": self.wip,
			"planned_start_date": planned or now_datetime(),
			"required_items": [{
				"item_code": ITEM, "item_name": ITEM, "required_qty": qty,
				"source_warehouse": self.store, "custom_batch_no": batch,
			}],
		})
		doc.flags.skip_stock_gate = skip_gate
		doc.insert(ignore_permissions=True)
		if submit:
			doc.submit()
		if state:
			doc.db_set("workflow_state", state, update_modified=False)
		frappe.db.commit()
		doc.reload()
		return doc

	def avail(self, **kw):
		return R.get_item_availability(self.store, [ITEM], **kw)[ITEM]

	def batch_row(self, entry, b):
		return next(x for x in entry["batches"] if x["batch_no"] == b)

	def reset_plans(self):
		"""Between tests: dead plans do not reserve, so mark everything stopped."""
		frappe.db.sql("""UPDATE `tabWork Order` wo JOIN `tabWork Order Item` woi ON woi.parent=wo.name
			SET wo.status='Stopped' WHERE woi.item_code=%s""", ITEM)
		frappe.db.commit()

	def setUp(self):
		frappe.set_user("Administrator")
		self.reset_plans()


class TestAvailability(RealBatchCase):
	def test_ledger_per_batch_and_item(self):
		a = self.avail()
		self.assertEqual(a["ledger"], 30)
		self.assertEqual(a["has_batch_no"], 1)
		self.assertEqual(self.batch_row(a, B1)["qty"], 10)
		self.assertEqual(self.batch_row(a, B2)["qty"], 20)
		self.assertEqual([b["batch_no"] for b in a["batches"]], [B1, B2])  # FEFO order
		self.assertNotIn(B3, [b["batch_no"] for b in a["batches"]])

	def test_reserved_per_batch_and_per_item(self):
		p1 = self.plan(4, batch=B1, submit=True)
		p2 = self.plan(6, batch=None)
		a = self.avail()
		self.assertEqual(a["reserved"], 10)
		self.assertEqual(a["reserved_submitted"], 4)
		self.assertEqual(self.batch_row(a, B1)["reserved"], 4)
		self.assertEqual(self.batch_row(a, B1)["available"], 6)
		self.assertEqual(self.batch_row(a, B2)["reserved"], 0)
		self.assertEqual({r["name"] for r in a["reserved_by"]}, {p1.name, p2.name})

	def test_both_remaining_figures(self):
		self.plan(4, submit=True)   # firm
		self.plan(6)                # draft
		a = self.avail(requested='{"%s": 5}' % ITEM)
		self.assertEqual(a["remaining_after_this_plan"], 30 - 4 - 5)
		self.assertEqual(a["remaining_if_all_pending_approved"], 30 - 10 - 5)

	def test_exclude_leaves_the_named_plan_out(self):
		p = self.plan(8, batch=B1)
		self.assertEqual(self.avail()["reserved"], 8)
		a = self.avail(exclude=p.name)
		self.assertEqual(a["reserved"], 0)
		self.assertEqual(self.batch_row(a, B1)["reserved"], 0)
		self.assertEqual(R.get_store_reservations(self.store, [ITEM], exclude=p.name)[ITEM], 0)


class TestWindow(RealBatchCase):
	def test_old_plan_does_not_reserve_recent_one_does(self):
		days = R.get_window_days()
		self.plan(3, planned=add_to_date(now_datetime(), days=-(days + 3)))
		self.assertEqual(self.avail()["reserved"], 0)
		self.plan(2, planned=add_to_date(now_datetime(), days=-(days - 1) if days > 1 else 0))
		self.assertEqual(self.avail()["reserved"], 2)

	def test_issued_states_and_stopped_do_not_reserve(self):
		for state in ("Chemical Issued", "Chemicals Issued Direct", "Tank Mix Manufactured",
					  "Spraying In Progress", "Completed"):
			self.plan(1, state=state)
		self.assertEqual(self.avail()["reserved"], 0)
		stopped = self.plan(1)
		stopped.db_set("status", "Stopped")
		frappe.db.commit()
		self.assertEqual(self.avail()["reserved"], 0)
		self.plan(1, state="Approved")
		self.assertEqual(self.avail()["reserved"], 1)


class TestGate(RealBatchCase):
	def test_item_level_overcommit_refused(self):
		self.plan(25)
		with self.assertRaises(frappe.ValidationError) as c:
			self.plan(10)
		self.assertIn("Not enough stock", str(c.exception))
		self.assertIn(ITEM, str(c.exception))
		self.assertIn("available 5", str(c.exception))

	def test_batch_level_overcommit_refused_though_item_total_fine(self):
		# 30 in the store, batch B1 holds 10: item total fits, the batch does not.
		with self.assertRaises(frappe.ValidationError) as c:
			self.plan(12, batch=B1)
		self.assertIn(B1, str(c.exception))
		# and a plan for a batch the store never held is refused too
		with self.assertRaises(frappe.ValidationError):
			self.plan(1, batch=B3)

	def test_batch_reserved_by_another_plan_counts(self):
		self.plan(8, batch=B1)
		with self.assertRaises(frappe.ValidationError):
			self.plan(5, batch=B1)
		self.plan(5, batch=B2)

	def test_fitting_plan_passes(self):
		p = self.plan(10, batch=B1)
		self.assertEqual(p.docstatus, 0)
		self.plan(20)  # 30 - 10 left, fits exactly

	def test_resaving_own_plan_does_not_double_count(self):
		p = self.plan(25)
		p.reload()
		p.save(ignore_permissions=True)


class TestStale(RealBatchCase):
	def _old(self):
		return add_to_date(now_datetime(), days=-(R.get_window_days() + 5))

	def test_listed_and_stopped(self):
		old_sub = self.plan(3, planned=self._old(), submit=True, state="Approved")
		fresh = self.plan(2)
		listed = {r["name"] for r in R.get_stale_plans()}
		self.assertIn(old_sub.name, listed)
		self.assertNotIn(fresh.name, listed)
		res = R.stop_stale_plans([old_sub.name, fresh.name])
		self.assertEqual(res["stopped"], [old_sub.name])
		self.assertEqual(res["skipped"], [fresh.name])
		self.assertEqual(frappe.db.get_value("Work Order", old_sub.name, "status"), "Stopped")
		self.assertEqual(frappe.db.get_value("Work Order", fresh.name, "docstatus"), 0)

	def test_draft_is_deleted(self):
		old = self.plan(3, planned=self._old())
		res = R.stop_stale_plans([old.name])
		self.assertEqual(res["deleted"], [old.name])
		self.assertFalse(frappe.db.exists("Work Order", old.name))

	def test_plan_no_longer_stale_is_skipped(self):
		p = self.plan(3, planned=self._old(), submit=True, state="Approved")
		self.assertIn(p.name, {r["name"] for r in R.get_stale_plans()})
		frappe.db.set_value("Work Order", p.name, "planned_start_date", now_datetime())
		res = R.stop_stale_plans([p.name])
		self.assertEqual(res["skipped"], [p.name])
		self.assertNotEqual(frappe.db.get_value("Work Order", p.name, "status"), "Stopped")
		# once issued it is skipped as well
		frappe.db.set_value("Work Order", p.name, "planned_start_date", self._old())
		frappe.db.set_value("Work Order", p.name, "workflow_state", "Chemical Issued")
		self.assertEqual(R.stop_stale_plans([p.name])["skipped"], [p.name])
		self.assertNotIn(p.name, {r["name"] for r in R.get_stale_plans()})


class TestStoreKeeperPath(RealBatchCase):
	def transfer(self, wo, qty):
		doc = frappe.get_doc({
			"doctype": "Stock Entry", "stock_entry_type": "Material Transfer for Manufacture",
			"company": COMPANY, "work_order": wo.name, "from_bom": 0,
			"from_warehouse": self.store, "to_warehouse": self.wip,
			"items": [{"item_code": ITEM, "qty": qty, "s_warehouse": self.store,
					   "t_warehouse": self.wip, "basic_rate": 10, "allow_zero_valuation_rate": 1}],
		})
		doc.insert(ignore_permissions=True)
		frappe.db.commit()
		return doc

	def test_planned_batch_suggested_first(self):
		# FEFO alone would say B1 (expires sooner); the plan chose B2.
		wo = self.plan(5, batch=B2, submit=True, state="Approved")
		se = self.transfer(wo, 5)
		row = store_keeper_api.suggest_transfer_batches(se.name)["rows"][0]
		self.assertEqual(row["suggestion"], B2)
		self.assertEqual(row["picks"][0]["batch_no"], B2)

	def test_falls_back_to_fefo_when_planned_batch_has_no_stock(self):
		wo = self.plan(5, batch=B2, submit=True, state="Approved")
		se = self.transfer(wo, 5)
		# planned batch B3 is not held by the store
		frappe.db.sql("UPDATE `tabWork Order Item` SET custom_batch_no=%s WHERE parent=%s", (B3, wo.name))
		row = store_keeper_api.suggest_transfer_batches(se.name)["rows"][0]
		self.assertEqual(row["suggestion"], B1)

	def test_autofill_uses_planned_then_submits(self):
		wo = self.plan(5, batch=B2, submit=True, state="Approved")
		se = self.transfer(wo, 5)
		filled = store_keeper_api.autofill_batches(se)
		self.assertEqual([(f["batch_no"], f["qty"]) for f in filled], [(B2, 5)])
		se.flags.ignore_links = True
		se.save(ignore_permissions=True)
		se.submit()
		se.reload()
		self.assertEqual(se.docstatus, 1)
		self.assertEqual([r.batch_no for r in se.items], [B2])
		self.assertEqual(self.batch_row(self.avail(), B2)["qty"], 15)

	def test_autofill_falls_back_to_fefo_then_submits(self):
		wo = self.plan(5, batch=B2, submit=True, state="Approved")
		se = self.transfer(wo, 5)
		frappe.db.sql("UPDATE `tabWork Order Item` SET custom_batch_no=%s WHERE parent=%s", (B3, wo.name))
		filled = store_keeper_api.autofill_batches(se)
		self.assertEqual([f["batch_no"] for f in filled], [B1])
		se.flags.ignore_links = True
		se.save(ignore_permissions=True)
		se.submit()
		se.reload()
		self.assertEqual(se.docstatus, 1)
		self.assertEqual(se.items[0].batch_no, B1)


class TestTransferStockGate(RealBatchCase):
	"""Stock 10 in B1, 20 in B2. Two approved transfers of 6 naming B1: the
	first fits, the second is blocked, and the submit path refuses it."""

	def transfer(self, qty, batch):
		frappe.flags.skip_stock_gate = True
		try:
			wo = self.plan(qty, batch=batch, submit=True, state="Approved")
		finally:
			frappe.flags.skip_stock_gate = False
		doc = frappe.get_doc({
			"doctype": "Stock Entry", "stock_entry_type": "Material Transfer for Manufacture",
			"company": COMPANY, "work_order": wo.name, "from_bom": 0,
			"from_warehouse": self.store, "to_warehouse": self.wip,
			"items": [{"item_code": ITEM, "qty": qty, "s_warehouse": self.store,
					   "t_warehouse": self.wip, "basic_rate": 10, "allow_zero_valuation_rate": 1,
					   "batch_no": batch, "use_serial_batch_fields": 1}],
		})
		doc.insert(ignore_permissions=True)
		emp = frappe.db.get_value("Employee", {}, "name")
		if emp:
			doc.db_set("bio_employee", emp, update_modified=False)
		frappe.db.commit()
		return doc

	def test_selection_order_decides_and_submit_checks_only_the_run(self):
		from unittest import mock
		t1 = self.transfer(6, B1)
		t2 = self.transfer(6, B1)
		# Nothing selected: each is judged alone, both fit.
		gate = store_keeper_api.get_transfer_stock_gate([t1.name, t2.name])
		self.assertTrue(gate[t1.name]["ok"] and gate[t2.name]["ok"])

		# Selecting the SECOND first gives it the stock.
		gate = store_keeper_api.get_transfer_stock_gate(
			[t1.name, t2.name], selected=[t2.name, t1.name])
		self.assertTrue(gate[t2.name]["ok"])
		self.assertFalse(gate[t1.name]["ok"])
		s = gate[t1.name]["shorts"][0]
		self.assertEqual((s["batch_no"], s["needed"], s["available_when_its_turn"], s["short_by"]),
						 (B1, 6, 4, 2))
		self.assertEqual(s["blocking_transfers"], [t2.name])

		# Only t2 selected: t1 is judged as if added next.
		gate = store_keeper_api.get_transfer_stock_gate([t1.name], selected=[t2.name])
		self.assertFalse(gate[t1.name]["ok"])

		# A run of [t2] alone succeeds; t1 (a draft outside the run) is ignored.
		with mock.patch.object(store_keeper_api, "_allow_submit_without_biometric", return_value=True):
			res = store_keeper_api.submit_without_biometric([t2.name])
		self.assertTrue(res["results"][0]["ok"], res["results"][0])

		# t1 now meets real stock: 4 left, short, no selected blocker.
		gate = store_keeper_api.get_transfer_stock_gate([t1.name])
		self.assertFalse(gate[t1.name]["ok"])
		s = gate[t1.name]["shorts"][0]
		self.assertEqual((s["available_when_its_turn"], s["blocking_transfers"]), (4, []))

		with mock.patch.object(store_keeper_api, "_allow_submit_without_biometric", return_value=True):
			res = store_keeper_api.submit_without_biometric([t1.name])
		r = res["results"][0]
		self.assertFalse(r["ok"])
		self.assertIn("Cannot be submitted \u2014 not enough stock", r["error"])
		self.assertIn("needs 6, 4 left", r["error"])
		self.assertEqual(frappe.db.get_value("Stock Entry", t1.name, "docstatus"), 0)
