"""A throwaway Application Floor Plan with its own stock, for tests that must commit.

Some chains commit as they go (`sync_spray_session`, `stop_stale_plans`), so a rollback
cannot undo them. A test that drives such a chain must therefore never touch a Work
Order, scan, bin or Stock Entry it did not create: borrowing a real plan to "reuse real
data" once had a teardown delete a live test plan's scan row and left cancelled entries
on it.

Everything here is created under a unique ``_TEST <tag>`` prefix: a chemical (batch
tracked), a finished tank-mix item and its BOM, three warehouses (store, CSU,
greenhouse), the batches, a Material Receipt, the Work Order and its transfer. `wipe`
removes by SQL every row keyed to that prefix, and is run at the start (a crashed earlier
run) and at the end. Nothing it deletes is selected by state or recency.
"""

import frappe
from frappe.utils import add_days, add_to_date, now_datetime, today

COMPANY = "Karen Roses"
AFP = "Application Floor Plan"
MTM = "Material Transfer for Manufacture"


def _like(prefix):
	return prefix.replace("_", r"\_") + "%"


def _delete_docs(doctype, names):
	"""Raw delete of the documents and their child rows. No hooks, no links check:
	only ever called with names this fixture created."""
	if not names:
		return
	names = list(names)
	meta = frappe.get_meta(doctype)
	for df in meta.get_table_fields():
		frappe.db.sql(
			f"DELETE FROM `tab{df.options}` WHERE parenttype=%s AND parent IN %s",
			(doctype, names),
		)
	frappe.db.sql(f"DELETE FROM `tab{doctype}` WHERE name IN %s", (names,))
	for t in ("Comment", "Version", "Activity Log"):
		col = "ref_doctype" if t == "Version" else "reference_doctype"
		nm = "docname" if t == "Version" else "reference_name"
		frappe.db.sql(f"DELETE FROM `tab{t}` WHERE `{col}`=%s AND `{nm}` IN %s", (doctype, names))


def wipe(prefix):
	"""Remove every row keyed to ``prefix``: items, warehouses, and whatever references
	them."""
	# A Spray Product is auto-created per Item and outlives it; left behind, it makes
	# every later save of the product list fail on the missing Item link.
	if frappe.db.exists("DocType", "Spray Product"):
		_delete_docs("Spray Product", frappe.db.sql_list(
			"SELECT name FROM `tabSpray Product` WHERE name LIKE %s", _like(prefix)))
	items = frappe.db.sql_list("SELECT name FROM `tabItem` WHERE name LIKE %s", _like(prefix))
	whs = frappe.db.sql_list(
		"SELECT name FROM `tabWarehouse` WHERE name LIKE %s", _like(prefix)
	)
	if not items and not whs:
		frappe.db.commit()
		return
	wos = set()
	if items:
		wos |= set(frappe.db.sql_list(
			"SELECT name FROM `tabWork Order` WHERE production_item IN %s", (items,)))
		wos |= set(frappe.db.sql_list(
			"SELECT DISTINCT parent FROM `tabWork Order Item` WHERE item_code IN %s", (items,)))
	if whs:
		wos |= set(frappe.db.sql_list(
			"SELECT name FROM `tabWork Order` WHERE wip_warehouse IN %s OR fg_warehouse IN %s",
			(whs, whs)))
	wos = list(wos)

	ses = set()
	if items:
		ses |= set(frappe.db.sql_list(
			"SELECT DISTINCT parent FROM `tabStock Entry Detail` WHERE item_code IN %s", (items,)))
	if whs:
		ses |= set(frappe.db.sql_list(
			"""SELECT DISTINCT parent FROM `tabStock Entry Detail`
			   WHERE s_warehouse IN %s OR t_warehouse IN %s""", (whs, whs)))
	if wos:
		ses |= set(frappe.db.sql_list(
			"SELECT name FROM `tabStock Entry` WHERE work_order IN %s", (wos,)))
	ses = list(ses)

	if wos:
		_delete_docs("Spray Application Logsheet", frappe.db.sql_list(
			"SELECT name FROM `tabSpray Application Logsheet` WHERE work_order IN %s", (wos,)
		) if frappe.get_meta("Spray Application Logsheet").has_field("work_order") else [])
		if frappe.db.table_exists("Sprayer Movement Session"):
			_delete_docs("Sprayer Movement Session", frappe.db.sql_list(
				"SELECT name FROM `tabSprayer Movement Session` WHERE work_order IN %s", (wos,)))
		tok = "Spray Session Token"
		if frappe.db.exists("DocType", tok) and frappe.get_meta(tok).has_field("work_order"):
			_delete_docs(tok, frappe.db.sql_list(
				f"SELECT name FROM `tab{tok}` WHERE work_order IN %s", (wos,)))

	bundles = []
	if items:
		bundles = frappe.db.sql_list(
			"SELECT name FROM `tabSerial and Batch Bundle` WHERE item_code IN %s", (items,))
	if bundles:
		frappe.db.sql("DELETE FROM `tabSerial and Batch Entry` WHERE parent IN %s", (bundles,))
		frappe.db.sql("DELETE FROM `tabSerial and Batch Bundle` WHERE name IN %s", (bundles,))
	if items:
		frappe.db.sql("DELETE FROM `tabStock Ledger Entry` WHERE item_code IN %s", (items,))
		frappe.db.sql("DELETE FROM `tabBin` WHERE item_code IN %s", (items,))
	if whs:
		frappe.db.sql("DELETE FROM `tabStock Ledger Entry` WHERE warehouse IN %s", (whs,))
		frappe.db.sql("DELETE FROM `tabBin` WHERE warehouse IN %s", (whs,))
	if ses:
		frappe.db.sql("DELETE FROM `tabStock Ledger Entry` WHERE voucher_no IN %s", (ses,))
		frappe.db.sql("DELETE FROM `tabGL Entry` WHERE voucher_no IN %s", (ses,))
		_delete_docs("Stock Entry", ses)
	_delete_docs("Work Order", wos)
	if items:
		boms = frappe.db.sql_list("SELECT name FROM `tabBOM` WHERE item IN %s", (items,))
		_delete_docs("BOM", boms)
		frappe.db.sql("DELETE FROM `tabBatch` WHERE item IN %s", (items,))
		frappe.db.sql("DELETE FROM `tabItem Default` WHERE parent IN %s", (items,))
		frappe.db.sql("DELETE FROM `tabItem` WHERE name IN %s", (items,))
	if whs:
		frappe.db.sql("DELETE FROM `tabWarehouse` WHERE name IN %s", (whs,))
	frappe.db.commit()


class ThrowawayPlan:
	"""Builds the fixture. ``days_ago`` places the receipt and transfer on the ledger."""

	def __init__(self, tag):
		self.prefix = f"_TEST {tag} "
		self.chem = f"{self.prefix}CHEM"
		self.fg = f"{self.prefix}MIX"
		self.wo_names = []

	def build(self, transfer_days_ago=4, receipt_days_ago=6, qty=2.0, transfer=True):
		"""Create everything. Returns self; ``self.wo`` is the plan, in 'Chemical Issued'
		with its chemical transferred into the CSU. With ``transfer=False`` the plan is
		left untouched (no receipt, no transfer, no state change), for tests that post
		their own stock against it; ``add_plan`` then makes more plans on the same CSU."""
		self.qty = qty
		self.transfer_days_ago = transfer_days_ago
		wipe(self.prefix)
		frappe.set_user("Administrator")
		self.abbr = frappe.db.get_value("Company", COMPANY, "abbr")
		self.farm = frappe.get_all("Farm", pluck="name", limit=1)[0]
		self.uom = "Litre" if frappe.db.exists("UOM", "Litre") else "Nos"
		group = frappe.get_all("Item Group", filters={"is_group": 0}, pluck="name")[0]

		self.store, self.csu, self.gh = (
			self._warehouse(n, farm=self.farm)
			for n in ("STORE", "CSU", "GH")
		)
		for code, batched in ((self.chem, 1), (self.fg, 0)):
			frappe.get_doc({
				"doctype": "Item", "item_code": code, "item_name": code, "item_group": group,
				"stock_uom": self.uom, "is_stock_item": 1, "has_batch_no": batched,
				"create_new_batch": 0, "valuation_rate": 10,
			}).insert(ignore_permissions=True)
		self.batch = f"{self.prefix}B1"
		frappe.get_doc({
			"doctype": "Batch", "batch_id": self.batch, "item": self.chem,
			"expiry_date": add_days(today(), 300),
		}).insert(ignore_permissions=True)

		bom = frappe.get_doc({
			"doctype": "BOM", "item": self.fg, "custom_farm": self.farm, "company": COMPANY, "quantity": 1,
			"uom": self.uom, "currency": frappe.db.get_value("Company", COMPANY, "default_currency"),
			"items": [{"item_code": self.chem, "qty": qty, "rate": 10, "uom": self.uom,
					   "stock_uom": self.uom, "conversion_factor": 1}],
		})
		bom.insert(ignore_permissions=True)
		bom.submit()
		self.bom = bom.name

		if transfer:
			self._se("Material Receipt", [{
				"item_code": self.chem, "qty": qty * 3, "t_warehouse": self.store,
				"batch_no": self.batch,
			}], receipt_days_ago)
		self.wo = self.add_plan(transfer=transfer)
		return self

	def add_plan(self, transfer=False):
		"""Another plan on this fixture's CSU. Returns the Work Order document."""
		qty, transfer_days_ago = self.qty, self.transfer_days_ago
		# The plan's own supervisor snapshot, so scans and the issue are credited without
		# reading the session user. The Employee is only linked to, never changed.
		emp = frappe.db.get_value("Employee", {"status": "Active", "company": COMPANY})
		wo = frappe.get_doc({
			"doctype": "Work Order", "company": COMPANY,
			"custom_cost_center": frappe.db.get_value(
				"Cost Center", {"company": COMPANY, "is_group": 0, "disabled": 0}),
			"custom_spray_plan_team_members": [
				{"employee": emp, "role": "Supervisor"}] if emp else [], "production_item": self.fg,
			"bom_no": self.bom, "qty": 1, "custom_type": AFP,
			"fg_warehouse": self.gh, "wip_warehouse": self.csu, "custom_greenhouse": self.gh,
			"planned_start_date": add_to_date(now_datetime(), days=-transfer_days_ago),
			"required_items": [{
				"item_code": self.chem, "item_name": self.chem, "required_qty": qty,
				"source_warehouse": self.store,
			}],
		})
		# The gate reads the global flag, not the document's; an untouched plan has no
		# stock behind it yet.
		gate = frappe.flags.get("skip_stock_gate")
		frappe.flags.skip_stock_gate = True
		try:
			wo.insert(ignore_permissions=True)
			wo.submit()
		finally:
			frappe.flags.skip_stock_gate = gate
		self.wo_names.append(wo.name)
		if transfer:
			self._se(MTM, [{
				"item_code": self.chem, "qty": qty, "s_warehouse": self.store,
				"t_warehouse": self.csu, "batch_no": self.batch,
			}], transfer_days_ago, work_order=wo.name)
			frappe.db.set_value("Work Order", wo.name, {
				"workflow_state": "Chemical Issued",
				"custom_scheduled_application_time": add_days(now_datetime(), 1),
			}, update_modified=False)
		frappe.db.commit()
		return frappe.get_doc("Work Order", wo.name)

	def owns(self, work_order):
		"""True only for a Work Order this fixture made."""
		return (
			work_order in self.wo_names
			and frappe.db.get_value("Work Order", work_order, "production_item") == self.fg
		)

	def assert_owns(self, work_order):
		assert self.owns(work_order), (
			f"refusing to touch {work_order}: it was not created by this test"
		)

	def _warehouse(self, name, farm=None):
		doc = frappe.get_doc({
			"doctype": "Warehouse", "warehouse_name": f"{self.prefix}{name}",
			"company": COMPANY, "custom_farm": farm,
		}).insert(ignore_permissions=True)
		return doc.name

	def _se(self, purpose, rows, days_ago, work_order=None):
		at = add_to_date(now_datetime().replace(microsecond=0), days=-days_ago)
		doc = frappe.get_doc({
			"doctype": "Stock Entry", "stock_entry_type": purpose, "purpose": purpose,
			"company": COMPANY, "work_order": work_order,
			"fg_completed_qty": 1 if work_order else 0,
			"set_posting_time": 1, "posting_date": at.date(), "posting_time": at.time(),
			"items": [
				dict(r, basic_rate=10, use_serial_batch_fields=1 if r.get("batch_no") else 0)
				for r in rows
			],
		})
		doc.flags.ignore_permissions = True
		doc.insert()
		doc.submit()
		return doc
