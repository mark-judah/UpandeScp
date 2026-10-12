"""Procurement scope, Business Unit, insights, and the finance review fixes — on
kaitet.local's data, all rolled back (`frappe.db.commit` is switched off).

Real users are used so the roles and rosters are the real ones: a Karen Roses
spray plan creator rostered on one farm, the Karen Roses GM, and the Kaitet Ltd.
GM. Each test skips if the site no longer has them.

Run (in-process):
    cd sites && ../env/bin/python -c "import frappe, unittest, importlib; frappe.init(site='kaitet.local');
    frappe.connect(); frappe.set_user('Administrator');
    M=importlib.import_module('upande_scp.serverscripts.tests.test_procurement_scope_db');
    unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(M))"
"""

import unittest
from unittest import mock

import frappe
from frappe.utils import flt

from upande_scp.serverscripts.common import crop_scope
from upande_scp.serverscripts.finance import accounts as acc
from upande_scp.serverscripts.finance import budgets as B
from upande_scp.serverscripts.finance import cost_centres as CC
from upande_scp.serverscripts.reports import finance_budget as FB
from upande_scp.serverscripts.store import procurement as P

KR, KL = "Karen Roses", "Kaitet Ltd."
CREATOR = "jkiprop@karenroses.com"  # Karen Roses, rostered on Kaptumbo only
CREATOR_FARM, OTHER_FARM = "Kaptumbo", "Chepsito"
KR_GM = "bob@karenroses.com"
KL_GM = "avocado.test@upande.com"  # Kaitet Ltd., Lokitela
KL_FARM = "Lokitela"
ITEM = "_test_scp_scope_item"
RATE = 100.0


class _Base(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.rollback()
		self._commit = mock.patch.object(frappe.db, "commit", lambda *a, **k: None)
		self._commit.start()
		for u in (CREATOR, KR_GM, KL_GM):
			if not frappe.db.exists("User", u):
				self.skipTest(f"needs {u}")
		crop_scope.clear_cache()
		if not frappe.db.exists("Item", ITEM):
			frappe.get_doc({
				"doctype": "Item", "item_code": ITEM, "item_name": ITEM, "item_group": "CHEMICALS",
				"stock_uom": "Kg", "is_stock_item": 1, "last_purchase_rate": RATE,
			}).insert(ignore_permissions=True)

	def tearDown(self):
		frappe.set_user("Administrator")
		crop_scope.clear_cache()
		self._commit.stop()
		frappe.db.rollback()

	def cycle(self, company=KR, name="_test_scope_cycle", status="Collecting"):
		return frappe.get_doc({
			"doctype": P.CYCLE, "cycle_name": name, "company": company,
			"period_start": "2026-10-01", "period_end": "2026-10-31", "status": status,
			"general_store": P.general_store_for(company),
		}).insert(ignore_permissions=True).name

	def requirement(self, cycle, farm, qty=10, status="Planner Approved", company=None):
		return frappe.get_doc({
			"doctype": P.REQUIREMENT, "cycle": cycle, "farm": farm, "company": company or KR,
			"status": status,
			"items": [{"item_code": ITEM, "uom": "Kg", "requested_qty": qty, "kind": "chemical"}],
		}).insert(ignore_permissions=True).name

	def as_user(self, user):
		frappe.set_user(user)
		crop_scope.clear_cache()


class TestScope(_Base):
	def test_a_creator_sees_only_the_farms_they_are_rostered_on(self):
		c = self.cycle()
		self.requirement(c, CREATOR_FARM)
		self.requirement(c, OTHER_FARM)
		self.as_user(CREATOR)
		self.assertEqual(P.visible_farms("Rose"), {CREATOR_FARM})
		self.assertEqual(P.my_farms(crop="Rose")["farms"], [CREATOR_FARM])
		self.assertEqual([r["farm"] for r in P.requirements_for(c, crop="Rose")], [CREATOR_FARM])
		self.assertEqual([f["farm"] for f in P.item_breakdown(c, crop="Rose")["farms"]], [CREATOR_FARM])

	def test_a_creator_cannot_read_or_write_an_unrostered_farm(self):
		c = self.cycle()
		other = self.requirement(c, OTHER_FARM, status="Draft")
		self.as_user(CREATOR)
		with self.assertRaises(frappe.PermissionError):
			P.my_requirement(c, OTHER_FARM)
		with self.assertRaises(frappe.PermissionError):
			P.save_requirement(other, [{"item_code": ITEM, "requested_qty": 5}])
		with self.assertRaises(frappe.PermissionError):
			P.submit_requirement(other)
		with self.assertRaises(frappe.PermissionError):
			P.review_requirement(other, "approve")
		with self.assertRaises(frappe.PermissionError):
			P.insights(OTHER_FARM, [ITEM])
		with self.assertRaises(frappe.PermissionError):
			P.request_from_pool(OTHER_FARM, [{"item_code": ITEM, "requested_qty": 1}])
		mine = P.my_requirement(c, CREATOR_FARM)  # their own farm still works
		self.assertEqual(mine["farm"], CREATOR_FARM)

	def test_a_creator_cannot_run_the_gm_steps(self):
		c = self.cycle()
		self.as_user(CREATOR)
		for fn in (P.consolidate, P.create_material_request, P.transfer_allocation, P.publish_allocation):
			with self.assertRaises(frappe.PermissionError):
				fn(c)

	def test_a_gm_sees_every_farm_of_their_company_but_no_other_companys(self):
		kl = self.cycle(KL, "_test_scope_kl")
		kr = self.cycle(KR, "_test_scope_kr")
		self.as_user(KR_GM)
		farms = P.visible_farms("Rose")
		self.assertIn(OTHER_FARM, farms)
		self.assertIn(CREATOR_FARM, farms)
		self.assertFalse({"Endebess", "Lokitela", "Saboti"} & farms)
		names = [x["name"] for x in P.list_cycles(crop="Rose")]
		self.assertIn(kr, names)
		self.assertNotIn(kl, names)
		self.assertEqual([c["company"] for c in P.companies_for_cycle(crop="Rose")], [KR])
		for fn in (P.get_cycle, P.requirements_for, P.preview_allocation, P.consumption_vs_allocation,
		           P.preview_material_request, P.item_breakdown, B.cycle_money):
			with self.assertRaises(frappe.PermissionError, msg=fn.__name__):
				fn(kl)
		with self.assertRaises(frappe.PermissionError):
			P.my_requirement(kl, KL_FARM)
		with self.assertRaises(frappe.PermissionError):
			P.consolidate(kl)
		with self.assertRaises(frappe.PermissionError):
			P.create_cycle("x", KL, "2026-10-01", "2026-10-31")

	def test_a_roses_user_cannot_even_ask_for_a_crop_that_is_not_theirs(self):
		self.as_user(KL_GM)
		with self.assertRaises(frappe.PermissionError):
			P.list_cycles(crop="Rose")
		kl = self.cycle(KL, "_test_scope_kl")
		self.as_user(KL_GM)
		self.assertIn(kl, [x["name"] for x in P.list_cycles(crop="Avocado")])

	def test_a_cycle_is_one_companys_so_another_companys_farm_cannot_join(self):
		kr = self.cycle(KR)
		with self.assertRaises(frappe.PermissionError):
			P.my_requirement(kr, KL_FARM)  # even as Administrator

	def test_consolidation_excludes_other_company_farms(self):
		kr = self.cycle(KR)
		self.requirement(kr, OTHER_FARM, qty=30)
		self.requirement(kr, KL_FARM, qty=500, company=KL)  # filed against the wrong company
		out = P.consolidate(kr)
		line = next(l for l in out["lines"] if l["item_code"] == ITEM)
		self.assertEqual(line["total_requested"], 30.0)
		self.assertEqual(P._farms_requesting(kr, ITEM), [OTHER_FARM])
		self.assertEqual(P._requested_by_farm(kr, ITEM), {OTHER_FARM: 30.0})
		prev = P.preview_allocation(kr)
		farms = {a["farm"] for l in prev["lines"] for a in l["allocations"]}
		self.assertNotIn(KL_FARM, farms)

	def test_the_picker_offers_only_the_cycles_companys_farms(self):
		kr = self.cycle(KR)
		farms = P.my_farms(crop="Rose", cycle=kr)["farms"]
		self.assertTrue(farms)
		self.assertFalse({"Endebess", "Lokitela", "SIMO", "Eldama"} & set(farms))

	def test_the_pool_is_scoped_to_the_callers_company(self):
		self.as_user(KR_GM)
		with self.assertRaises(frappe.PermissionError):
			P.pool_status(KL)
		with self.assertRaises(frappe.PermissionError):
			P.pool_availability(KL, [ITEM])
		self.assertEqual(P.pool_status(crop="Rose")["store"], P.general_store_for(KR))


class TestBusinessUnit(_Base):
	def setUp(self):
		super().setUp()
		frappe.db.set_single_value("Buying Settings", "allow_multiple_items", 1)
		if not P.general_store_for(KR):
			self.skipTest("Karen Roses has no general store")
		frappe.get_doc({"doctype": "Business Unit", "business_unit_name": "_test_bu"}).insert(
			ignore_permissions=True
		)
		self.c = self.cycle(KR)
		self.requirement(self.c, OTHER_FARM, qty=30)
		P.consolidate(self.c)

	def test_it_is_stamped_on_the_mr_rows_and_the_drafted_budgets_when_resolvable(self):
		with mock.patch.object(CC, "dimension_default", return_value="_test_bu"):
			rows = [r for r in P.preview_material_request(self.c)["rows"] if r["item_code"] == ITEM]
			self.assertEqual({r["business_unit"] for r in rows}, {"_test_bu"})
			mr = frappe.get_doc("Material Request", P.create_material_request(self.c))
			self.assertEqual({r.business_unit for r in mr.items if r.item_code == ITEM}, {"_test_bu"})
		budgets = frappe.get_all("Budget", filters={B.TAG: self.c}, pluck="business_unit")
		if budgets:
			self.assertEqual(set(budgets), {"_test_bu"})

	def test_it_comes_from_the_farm_before_the_dimension_default(self):
		with mock.patch.object(CC, "_has_column", return_value=True), \
				mock.patch("frappe.db.get_value", side_effect=lambda dt, *a, **k: "_farm_bu" if dt == "Farm" else None):
			self.assertEqual(CC.business_unit_for(OTHER_FARM, KR), "_farm_bu")

	def test_unresolved_is_left_blank_not_guessed(self):
		with mock.patch.object(CC, "dimension_default", return_value=None):
			rows = [r for r in P.preview_material_request(self.c)["rows"] if r["item_code"] == ITEM]
			self.assertEqual({r["business_unit"] for r in rows}, {None})
			mr = frappe.get_doc("Material Request", P.create_material_request(self.c))
			self.assertFalse([r.business_unit for r in mr.items if r.item_code == ITEM and r.business_unit])


class TestInsights(_Base):
	def test_the_figures(self):
		from upande_scp.serverscripts.common import stores

		store = (stores.farm_stores(OTHER_FARM, "chemical") or [None])[0]
		if not store:
			self.skipTest("Chepsito has no chemical store")
		frappe.get_doc({"doctype": "Bin", "item_code": ITEM, "warehouse": store, "actual_qty": 42}).insert(
			ignore_permissions=True
		)
		frappe.get_doc({
			"doctype": "Chemical Allocation Credit", "farm": OTHER_FARM, "item_code": ITEM, "uom": "Kg",
			"credit_qty": 3.5,
		}).insert(ignore_permissions=True)
		old = frappe.get_doc({
			"doctype": P.CYCLE, "cycle_name": "_test_last", "company": KR, "period_start": "2026-01-01",
			"period_end": "2026-01-31", "status": "Allocated", "general_store": P.general_store_for(KR),
			"allocations": [{"item_code": ITEM, "farm": OTHER_FARM, "uom": "Kg", "allocated_qty": 17}],
		}).insert(ignore_permissions=True)
		now = self.cycle(KR)
		with mock.patch.object(P, "_consumed", return_value={ITEM: 12.0}) as consumed:
			out = P.insights(OTHER_FARM, [ITEM, "_no_such_item_"], cycle=now)
		it = out["items"][ITEM]
		self.assertEqual(it["on_hand"], 42.0)
		self.assertEqual(it["consumed"], 12.0)
		self.assertEqual(it["last_approved"], 17.0)
		self.assertEqual(it["last_cycle"], old.name)
		self.assertEqual(it["credit"], 3.5)
		self.assertEqual(it["rate"], RATE)
		self.assertEqual(it["uom"], "Kg")
		self.assertEqual(consumed.call_count, 1, "one batched query for all the items")
		self.assertEqual(out["items"]["_no_such_item_"]["on_hand"], 0.0)
		self.assertIsNone(out["items"]["_no_such_item_"]["last_approved"])
		self.assertEqual(out["weeks"], 8)


class TestMoneyAccess(_Base):
	def test_a_creator_gets_only_their_farms_money_and_a_gm_only_their_company(self):
		c = self.cycle(KR)
		self.requirement(c, CREATOR_FARM, qty=5)
		self.requirement(c, OTHER_FARM, qty=5)
		P.consolidate(c)
		self.as_user(CREATOR)
		money = B.cycle_money(c)
		self.assertEqual({f["farm"] for f in money["farms"]}, {CREATOR_FARM})
		self.assertEqual({l["farm"] for l in money["lines"]}, {CREATOR_FARM})
		kl = self.cycle(KL, "_test_money_kl")
		self.as_user(KR_GM)
		with self.assertRaises(frappe.PermissionError):
			B.cycle_money(kl)
		with self.assertRaises(frappe.PermissionError):
			B.draft_budgets(kl)


class TestCosting(_Base):
	def test_a_published_cycle_is_costed_from_its_published_split_not_todays_preview(self):
		c = self.cycle(KR)
		self.requirement(c, OTHER_FARM, qty=30)
		self.requirement(c, "Kapkolia", qty=70)
		P.consolidate(c)
		P.publish_allocation(c)
		self.assertEqual(frappe.db.get_value(P.CYCLE, c, "status"), "Allocated")
		before = {(l["item_code"], l["farm"]): l["approved_qty"] for l in B.cycle_lines(c)["lines"]}
		with mock.patch.object(P, "_preview_allocation", side_effect=AssertionError("live preview used")):
			after = {(l["item_code"], l["farm"]): l["approved_qty"] for l in B.cycle_lines(c)["lines"]}
		self.assertEqual(before, after)
		self.assertEqual(after[(ITEM, OTHER_FARM)], 30.0)

	def test_a_unit_other_than_stock_is_costed_through_its_conversion_factor(self):
		item = frappe.get_doc("Item", ITEM)
		item.append("uoms", {"uom": "Box", "conversion_factor": 10})
		item.save(ignore_permissions=True)
		self.assertEqual(acc.uom_factor(ITEM, "Kg"), 1.0)
		self.assertEqual(acc.uom_factor(ITEM, "Box"), 10.0)
		c = self.cycle(KR)
		self.requirement(c, OTHER_FARM, qty=3)
		P.consolidate(c)
		cyc = frappe.get_doc(P.CYCLE, c)
		cyc.lines[0].uom = "Box"
		cyc.save(ignore_permissions=True)
		line = next(l for l in B.cycle_lines(c)["lines"] if l["farm"] == OTHER_FARM)
		self.assertEqual(line["conversion_factor"], 10.0)
		self.assertEqual(line["rate"], RATE * 10)
		self.assertEqual(line["value"], 3 * 10 * RATE)


class TestFinanceBudgetReport(_Base):
	def test_an_account_shared_by_both_kinds_is_counted_once_and_said_so(self):
		with mock.patch.object(acc, "accounts_for_kind", return_value=["50100301 - Chemicals Expense - KR"]):
			out = FB.budget_vs_actual("2026-01-01", "2026-12-31", crop="Rose")
		self.assertTrue(any("both" in n and "50100301" in n for n in out["notes"]), out["notes"])
		for f in out["farms"]:
			self.assertEqual(flt(f["kinds"]["foliar"]["actual"]), 0.0, "not doubled under foliar")
			self.assertEqual(flt(f["kinds"]["foliar"]["budget"]), 0.0)

	def test_farms_sharing_a_cost_centre_group_are_warned_not_double_counted(self):
		with mock.patch.object(FB, "farm_cost_center", return_value="Chepsito Farm - KR"):
			out = FB.budget_vs_actual("2026-01-01", "2026-12-31", crop="Rose")
		self.assertTrue(any("share one cost-centre group" in n for n in out["notes"]), out["notes"])
		self.assertEqual(sum(flt(f["budget"]) + flt(f["actual"]) for f in out["farms"] if f["mapped"]), 0.0)

	def test_a_budget_counts_when_its_years_overlap_the_report(self):
		cc = "Chepsito Farm - KR"
		if not frappe.db.exists("Cost Center", cc):
			self.skipTest("needs Chepsito's cost-centre group")
		frappe.db.set_value("Farm", OTHER_FARM, "custom_cost_center", cc)
		frappe.db.sql("delete from `tabBudget`")  # rolled back; one Budget per centre and account
		account = (acc.accounts_for_kind(KR, "chemical") or [None])[0]
		if not account:
			self.skipTest("no chemical account")
		B._save_budget(
			frappe.get_doc(B._budget_doc_values(KR, cc, account, "2026", 1234.0, self.cycle(KR), OTHER_FARM)),
			spent=1e12,  # past ERPNext's spent-already check, as SCP drafts do
		)
		out = FB.budget_vs_actual("2026-10-01", "2026-10-31", crop="Rose")
		chep = next(f for f in out["farms"] if f["farm"] == OTHER_FARM)
		self.assertEqual(flt(chep["draft_budget"]), 1234.0)


class TestOffFarmYear(_Base):
	def test_off_farm_expense_runs_from_the_fiscal_year_start(self):
		from upande_scp.serverscripts.finance import cost_centre_mapping as M

		with mock.patch.object(B, "_fiscal_year", return_value="2026"), mock.patch(
			"frappe.db.get_value", side_effect=lambda dt, *a, **k: "2026-04-01" if dt == "Fiscal Year" else None
		):
			self.assertEqual(str(M._fiscal_year_start(KR)), "2026-04-01")
		with mock.patch.object(B, "_fiscal_year", return_value=None):
			self.assertEqual(M._fiscal_year_start(KR).month, 1)
