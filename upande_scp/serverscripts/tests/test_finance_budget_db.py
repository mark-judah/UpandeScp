"""Finance on cost centres and budgets, against kaitet.local data (B2-B10).

Everything here is rolled back: `frappe.db.commit` is switched off for the
duration (the procurement endpoints commit as they go), and each test ends in a
rollback. Nothing these tests write survives them.

Run (in-process):
    cd sites && ../env/bin/python -c "import frappe, unittest; frappe.init(site='kaitet.local');
    frappe.connect(); frappe.set_user('Administrator'); import importlib;
    M=importlib.import_module('upande_scp.serverscripts.tests.test_finance_budget_db');
    unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(M))"
"""

import unittest
from unittest import mock

import frappe
from frappe.utils import flt

from upande_scp.serverscripts.finance import budgets as B
from upande_scp.serverscripts.finance import cost_centre_mapping as M
from upande_scp.serverscripts.finance import cost_centres as CC
from upande_scp.serverscripts.spray_plan_creator import stock_entry_state as S
from upande_scp.serverscripts.store import procurement as P

COMPANY = "Karen Roses"
FARMS = ("Chepsito", "Kapkolia")
GROUPS = {"Chepsito": "Chepsito Farm - KR", "Kapkolia": "Kapkolia Farm - KR"}
ITEM = "_test_scp_fin_item"
RATE = 250.0


class _RolledBack(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.rollback()
		self._commit = mock.patch.object(frappe.db, "commit", lambda *a, **k: None)
		self._commit.start()
		if not frappe.db.exists("Company", COMPANY) or not all(frappe.db.exists("Farm", f) for f in FARMS):
			self.skipTest("needs kaitet.local's Karen Roses farms")

	def tearDown(self):
		self._commit.stop()
		frappe.db.rollback()
		frappe.clear_cache(doctype="Budget")


class TestCycleMoney(_RolledBack):
	"""B2, B3, B5 on a cycle built inside the transaction."""

	def setUp(self):
		super().setUp()
		frappe.get_doc({
			"doctype": "Item", "item_code": ITEM, "item_name": ITEM, "item_group": "CHEMICALS",
			"stock_uom": "Kg", "is_stock_item": 1, "last_purchase_rate": RATE,
		}).insert(ignore_permissions=True)
		# Chepsito is fully mapped; Kapkolia has its group but no purchase leaf.
		frappe.db.set_value("Farm", "Chepsito", {
			"custom_cost_center": GROUPS["Chepsito"], "custom_purchase_cost_center": "Chepsito - KR",
		})
		frappe.db.set_value("Farm", "Kapkolia", {
			"custom_cost_center": GROUPS["Kapkolia"], "custom_purchase_cost_center": None,
		})
		self.cycle = frappe.get_doc({
			"doctype": P.CYCLE, "cycle_name": "_test_scp_fin_cycle", "company": COMPANY,
			"period_start": "2026-10-01", "period_end": "2026-10-31", "status": "Collecting",
			"general_store": P.general_store_for(COMPANY),
		}).insert(ignore_permissions=True).name
		for farm, qty in (("Chepsito", 30), ("Kapkolia", 70)):
			frappe.get_doc({
				"doctype": P.REQUIREMENT, "cycle": self.cycle, "farm": farm, "company": COMPANY,
				"status": "Planner Approved",
				"items": [{"item_code": ITEM, "uom": "Kg", "requested_qty": qty, "kind": "chemical"}],
			}).insert(ignore_permissions=True)
		P.consolidate(self.cycle)
		if not P.general_store_for(COMPANY):
			self.skipTest("Karen Roses has no general store")
		# A row per item x farm needs ERPNext to accept a repeated item.
		frappe.db.set_single_value("Buying Settings", "allow_multiple_items", 1)

	def test_the_mr_has_a_row_per_item_and_farm_with_its_money(self):
		mr = frappe.get_doc("Material Request", P.create_material_request(self.cycle))
		rows = {r.farm: r for r in mr.items if r.item_code == ITEM}
		self.assertEqual(set(rows), set(FARMS), "one row per farm, not one consolidated line")
		self.assertEqual(flt(rows["Chepsito"].qty) + flt(rows["Kapkolia"].qty), 100.0)
		self.assertEqual(flt(rows["Chepsito"].qty), 30.0)
		for r in rows.values():
			self.assertEqual(flt(r.rate), RATE)
			self.assertEqual(r.expense_account, "50100301 - Chemicals Expense - KR")
		self.assertEqual(rows["Chepsito"].cost_center, "Chepsito - KR")
		self.assertEqual(mr.docstatus, 0, "still a draft for purchasing")

	def test_a_row_with_no_purchase_cost_centre_is_not_sent_to_main_silently(self):
		"""ERPNext fills a blank row with the company default on validate; the MR
		has to say so, naming where the money went."""
		mr = frappe.get_doc("Material Request", P.create_material_request(self.cycle))
		main = frappe.db.get_value("Company", COMPANY, "cost_center")
		notes = frappe.get_all(
			"Comment", filters={"reference_doctype": "Material Request", "reference_name": mr.name},
			pluck="content",
		)
		self.assertTrue(
			any("No farm or greenhouse cost centre" in n and "Kapkolia" in n and main in n for n in notes),
			notes,
		)

	def test_without_repeated_items_it_is_one_row_per_item_and_says_why(self):
		frappe.db.set_single_value("Buying Settings", "allow_multiple_items", 0)
		out = P.preview_material_request(self.cycle)
		mine = [r for r in out["rows"] if r["item_code"] == ITEM]
		self.assertEqual(len(mine), 1)
		self.assertEqual(mine[0]["qty"], 100.0)
		self.assertIsNone(mine[0]["farm"], "two farms share the row, so it names neither")
		self.assertIsNone(mine[0]["cost_center"])
		self.assertFalse(out["per_farm"])
		self.assertTrue(any("Allow Item to be added multiple times" in w for w in out["warnings"]))
		mr = frappe.get_doc("Material Request", P.create_material_request(self.cycle))
		self.assertEqual(len([r for r in mr.items if r.item_code == ITEM]), 1)

	def test_the_preview_writes_nothing(self):
		before = frappe.db.count("Material Request")
		out = P.preview_material_request(self.cycle)
		self.assertEqual(frappe.db.count("Material Request"), before)
		mine = [r for r in out["rows"] if r["item_code"] == ITEM]
		self.assertEqual(len(mine), 2)
		self.assertAlmostEqual(sum(r["amount"] for r in mine), 100 * RATE)

	def test_approving_drafts_tagged_warn_only_budgets_idempotently(self):
		P.create_material_request(self.cycle)
		names = frappe.get_all(
			"Budget", filters={B.TAG: self.cycle, "docstatus": 0}, pluck="name"
		)
		self.assertTrue(names, "approval drafts the year's Budgets")
		chep = [n for n in names if frappe.db.get_value("Budget", n, "cost_center") == GROUPS["Chepsito"]]
		self.assertEqual(len(chep), 1)
		b = frappe.get_doc("Budget", chep[0])
		self.assertEqual(b.from_fiscal_year, "2026")
		self.assertGreaterEqual(flt(b.budget_amount), 30 * RATE)
		for f in ("action_if_annual_budget_exceeded_on_mr", "action_if_annual_budget_exceeded_on_po",
		          "action_if_annual_budget_exceeded", "action_if_accumulated_monthly_budget_exceeded"):
			self.assertEqual(b.get(f), "Warn", f)
		self.assertTrue(b.budget_distribution, "the monthly distribution is still written")

		again = B.draft_budgets(self.cycle)
		self.assertEqual(
			{r["action"] for r in again["rows"] if r["cost_center"] in GROUPS.values()}, {"unchanged"}
		)
		self.assertEqual(
			frappe.db.count("Budget", {"cost_center": GROUPS["Chepsito"], "docstatus": ("<", 2)}), 1,
			"re-drafting never makes a second Budget",
		)

	def test_a_submitted_budget_is_never_touched(self):
		P.create_material_request(self.cycle)
		name = frappe.db.get_value("Budget", {B.TAG: self.cycle, "cost_center": GROUPS["Chepsito"]}, "name")
		frappe.db.set_value("Budget", name, {"docstatus": 1, "budget_amount": 1.0})
		out = B.draft_budgets(self.cycle)
		row = next(r for r in out["rows"] if r["cost_center"] == GROUPS["Chepsito"])
		self.assertEqual(row["action"], "left alone")
		self.assertEqual(flt(frappe.db.get_value("Budget", name, "budget_amount")), 1.0)

	def test_the_farm_over_its_budget_is_warned(self):
		P.create_material_request(self.cycle)
		name = frappe.db.get_value("Budget", {B.TAG: self.cycle, "cost_center": GROUPS["Chepsito"]}, "name")
		frappe.db.set_value("Budget", name, {"docstatus": 1, "budget_amount": 100.0})
		money = B.cycle_money(self.cycle)
		chep = next(f for f in money["farms"] if f["farm"] == "Chepsito")
		self.assertEqual(chep["budget"], 100.0)
		self.assertTrue(chep["over_budget"])
		self.assertIn("Chepsito", money["over_budget"])
		self.assertAlmostEqual(chep["approved_value"], 30 * RATE)
		kap = next(f for f in money["farms"] if f["farm"] == "Kapkolia")
		self.assertFalse(kap["over_budget"], "a draft Budget is not a limit yet")


class TestNoSilentFallback(_RolledBack):
	"""B9."""

	def test_a_store_resolves_to_its_farms_purchase_cost_centre(self):
		store = frappe.db.get_value("Farm", "Chepsito", "custom_chemical_store")
		if not store:
			self.skipTest("Chepsito has no chemical store")
		frappe.db.set_value("Warehouse", store, "custom_cost_center", None)
		frappe.db.set_value("Farm", "Chepsito", "custom_purchase_cost_center", "Chepsito - KR")
		self.assertEqual(CC.resolve(store), ("Chepsito - KR", "farm purchase"))

	def test_nothing_resolved_is_said_on_the_document_once(self):
		se = frappe.get_doc("Stock Entry", frappe.db.get_value("Stock Entry", {"docstatus": 1}, "name"))
		before = [r.cost_center for r in se.items]
		S._stamp_rows(se, None, "WO-TEST-0001")
		S._stamp_rows(se, None, "WO-TEST-0001")
		self.assertEqual([r.cost_center for r in se.items], before, "rows left to ERPNext, not Main")
		notes = frappe.get_all(
			"Comment",
			filters={"reference_doctype": "Stock Entry", "reference_name": se.name,
			         "content": ("like", "%WO-TEST-0001%")},
			pluck="name",
		)
		self.assertEqual(len(notes), 1)


class TestMappingAudit(_RolledBack):
	"""B8."""

	def _state(self):
		return (
			frappe.db.count("Warehouse", {"company": COMPANY, "custom_cost_center": ("is", "set")}),
			frappe.db.count("Cost Center", {"company": COMPANY, "custom_farm": ("is", "set")}),
			frappe.db.count("Farm", {"custom_cost_center": ("is", "set")}),
		)

	def test_the_dry_run_changes_nothing(self):
		before = self._state()
		out = M.audit(COMPANY)
		self.assertFalse(out["applied"])
		self.assertEqual(self._state(), before)
		self.assertGreater(out["counts"]["warehouses_matched"] + out["counts"]["warehouses_already_linked"], 0)

	def test_apply_fills_the_links_and_moves_no_cost_centre(self):
		parents = dict(frappe.get_all(
			"Cost Center", filters={"company": COMPANY}, fields=["name", "parent_cost_center"], as_list=True
		))
		dry = M.audit(COMPANY)
		M.audit(COMPANY, apply=1)
		wh, cc, farm = self._state()
		self.assertGreaterEqual(wh, dry["counts"]["warehouses_matched"])
		self.assertGreaterEqual(cc, dry["counts"]["cost_centres_to_tag"])
		for f in ("Chepsito", "Simotwo", "Karen"):
			self.assertTrue(frappe.db.get_value("Farm", f, "custom_cost_center"), f)
		self.assertEqual(frappe.db.get_value("Farm", "Simotwo", "custom_cost_center"), "Simotwo  Farm - KR")
		after = dict(frappe.get_all(
			"Cost Center", filters={"company": COMPANY}, fields=["name", "parent_cost_center"], as_list=True
		))
		self.assertEqual(after, parents, "the audit never moves a cost centre")

	def test_misfiled_greenhouses_are_reported(self):
		out = M.audit(COMPANY)
		mis = {m["cost_center"] for m in out["misfiled"]}
		for cc in ("Torongo GH18 - KR", "KarenGH10 - KR"):
			if frappe.db.exists("Cost Center", cc):
				self.assertIn(cc, mis)
		off = {o["cost_center"] for o in out["off_farm_expense"]}
		self.assertIn("Main - KR", off)


class TestConsumptionIsUse(_RolledBack):
	"""B10: issues and the tank-mix manufacture count; moves between own stores do not."""

	def test_transfers_into_the_csu_are_not_consumption(self):
		item, farm = "1110009", "Chepsito"
		start, end = "2026-08-01", "2026-09-30"
		whs = P._farm_consumption_warehouses(farm)
		if not whs:
			self.skipTest("Chepsito has no stores")
		cycle = frappe.get_doc({
			"doctype": P.CYCLE, "cycle_name": "_test_scp_b10", "company": COMPANY,
			"period_start": start, "period_end": end, "status": "Allocated",
			"allocations": [{"item_code": item, "farm": farm, "allocated_qty": 1}],
		}).insert(ignore_permissions=True)
		got = P.consumption_vs_allocation(cycle.name)[0]["consumed"]

		def out_of(purposes, types_excluded=("Chemical Loaning",)):
			return flt(frappe.db.sql(
				"""SELECT COALESCE(SUM(-sle.actual_qty), 0) FROM `tabStock Ledger Entry` sle
				   JOIN `tabStock Entry` se ON se.name = sle.voucher_no
				   WHERE sle.voucher_type = 'Stock Entry' AND se.purpose IN %s
				     AND IFNULL(se.stock_entry_type, '') NOT IN %s
				     AND sle.item_code = %s AND sle.warehouse IN %s AND sle.actual_qty < 0
				     AND sle.is_cancelled = 0 AND sle.posting_date BETWEEN %s AND %s""",
				(purposes, types_excluded, item, tuple(whs), start, end),
			)[0][0])

		use = out_of(("Material Issue", "Manufacture"))
		moved = out_of(("Material Transfer for Manufacture", "Material Transfer"))
		self.assertAlmostEqual(got, use)
		if moved:
			self.assertNotAlmostEqual(got, use + moved, msg="a store-to-CSU transfer is not use")


if __name__ == "__main__":
	unittest.main()
