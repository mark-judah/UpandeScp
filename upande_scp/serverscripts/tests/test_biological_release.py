"""Predator master seed, Biological Release posting, presence and warnings. DB test:

    cd sites && ../env/bin/python -c "import frappe, unittest; \
        frappe.init(site='kaitet.local'); frappe.connect(); frappe.set_user('Administrator'); \
        from upande_scp.serverscripts.tests import test_biological_release as T; \
        unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromModule(T)); frappe.db.rollback()"

Everything runs inside one transaction that is rolled back.
"""

import unittest

import frappe
from frappe.utils import add_days, now_datetime

from upande_scp.serverscripts.biologicals import release as REL
from upande_scp.serverscripts.biologicals import seed_impacts, seed_predators
from upande_scp.serverscripts.spray_compliance import context as C
from upande_scp.serverscripts.spray_compliance import engine as E

GH = "Karen GH 01 - KR"
PP = "Phytoseiulus"
ITEM = "Phytoseiulus persimilis"


def _receipt(item, store, qty, rate, zero=False):
	company = frappe.db.get_value("Warehouse", store, "company")
	row = {"item_code": item, "qty": qty, "t_warehouse": store, "basic_rate": rate}
	if zero:
		row["allow_zero_valuation_rate"] = 1
	doc = frappe.get_doc({"doctype": "Stock Entry", "stock_entry_type": "Material Receipt", "purpose": "Material Receipt",
	                      "company": company, "items": [row]})
	doc.flags.ignore_permissions = True
	doc.insert()
	doc.submit()


def _bin(item, store):
	return frappe.db.get_value("Bin", {"item_code": item, "warehouse": store}, "actual_qty") or 0


class TestSeedIsIdempotent(unittest.TestCase):
	def test_predator_master_is_clean(self):
		names = set(frappe.get_all("Predator", pluck="name"))
		self.assertEqual(names, {"Phytoseiulus", "Neoseiulus californicus"})
		pp = frappe.get_doc("Predator", PP)
		self.assertEqual(pp.scientific_name, "Phytoseiulus persimilis")
		self.assertEqual([r.stage for r in pp.predator_stages], ["Eggs", "Nymph", "Adult"])
		self.assertTrue(all(frappe.db.exists("Stage", r.stage) for r in pp.predator_stages))
		self.assertEqual([(r.pest, r.efficacy[0]) for r in pp.target_pest], [("Spidermites", "3")])
		nc = frappe.get_doc("Predator", "Neoseiulus californicus")
		self.assertEqual({r.pest for r in nc.target_pest}, {"Spidermites", "Thrips"})
		self.assertTrue(all(r.source for r in nc.target_pest))
		self.assertEqual(nc.common_name, "Neoseiulus californicus")
		self.assertEqual(frappe.db.get_value("Item", ITEM, "item_group"), "Biologicals")

	def test_no_scouting_row_still_uses_the_retired_predators(self):
		for old in ("Carlifonicus", "Nymphs", "Eggs"):
			self.assertEqual(frappe.db.count("Predators Scouting Entry", {"predator": old}), 0)
			self.assertFalse(frappe.db.exists("Predator", old))
		self.assertEqual(frappe.db.count("Predator Filter", {"predator": ["in", ["Nymphs", "Eggs", "Carlifonicus"]]}), 0)

	def test_seed_rerun_changes_nothing(self):
		before = (frappe.db.count("Predator Targets"), frappe.db.count("Predator Stages"),
		          frappe.db.count("Active Ingredient Predator Impact"))
		r1, r2 = seed_predators.run(), seed_impacts.run()
		self.assertEqual(r2["added"], 0)
		self.assertFalse(r1.get("renamed") or r1.get("deleted") or r1.get("updated") or r1.get("scouting_repointed"))
		after = (frappe.db.count("Predator Targets"), frappe.db.count("Predator Stages"),
		         frappe.db.count("Active Ingredient Predator Impact"))
		self.assertEqual(before, after)

	def test_impacts_are_unverified_and_cited(self):
		rows = frappe.get_all("Active Ingredient Predator Impact", fields=["verified", "source", "impact_class"])
		self.assertTrue(rows)
		self.assertTrue(all(not r.verified and r.source for r in rows))
		em = frappe.get_doc("Active Ingredient MoA", "Emamectin benzoate")
		self.assertEqual({r.predator: r.impact_class[0] for r in em.predator_impacts}, {PP: "4", "Neoseiulus californicus": "3"})


class TestRelease(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		self.store = REL.stores.primary_store("Karen", "chemical")

	def tearDown(self):
		frappe.db.rollback()

	def test_release_issues_stock_from_the_store_and_dedupes(self):
		_receipt(ITEM, self.store, 10, 120)
		before = _bin(ITEM, self.store)
		out = REL.release_biological(GH, PP, 2, stage="Adult", client_id="t-1")
		self.assertFalse(out["duplicate"])
		doc = frappe.get_doc("Biological Release", out["name"])
		self.assertEqual((doc.docstatus, doc.store, doc.item, doc.uom, doc.farm, doc.crop), (1, self.store, ITEM, "Bottle", "Karen", "Rose"))
		se = frappe.get_doc("Stock Entry", doc.stock_entry)
		self.assertEqual((se.docstatus, se.purpose, se.items[0].s_warehouse, se.items[0].qty), (1, "Material Issue", self.store, 2))
		self.assertGreater(se.items[0].basic_rate, 0)
		self.assertFalse(se.items[0].allow_zero_valuation_rate)
		self.assertEqual(_bin(ITEM, self.store), before - 2)
		again = REL.release_biological(GH, PP, 2, stage="Adult", client_id="t-1")
		self.assertTrue(again["duplicate"] and again["name"] == out["name"])
		self.assertEqual(frappe.db.count("Biological Release", {"client_id": "t-1"}), 1)
		self.assertEqual(_bin(ITEM, self.store), before - 2)

	def test_cancel_returns_the_stock(self):
		_receipt(ITEM, self.store, 5, 120)
		doc = frappe.get_doc("Biological Release", REL.release_biological(GH, PP, 1, client_id="t-2")["name"])
		doc.cancel()
		self.assertEqual(_bin(ITEM, self.store), 5)

	def test_not_enough_stock_is_refused_plainly(self):
		with self.assertRaises(frappe.ValidationError) as cm:
			REL.release_biological(GH, PP, 999999, client_id="t-3")
		self.assertIn("holds", str(cm.exception))

	def test_zero_valued_stock_is_never_issued(self):
		_receipt(ITEM, self.store, 4, 0, zero=True)
		with self.assertRaises(frappe.ValidationError) as cm:
			REL.release_biological(GH, PP, 1, client_id="t-4")
		self.assertIn("no value", str(cm.exception).lower())
		self.assertEqual(frappe.db.count("Biological Release", {"client_id": "t-4"}), 0)

	def test_only_roses_and_only_real_stages(self):
		with self.assertRaises(frappe.ValidationError):
			REL.release_biological(GH, PP, 1, stage="Pupae", client_id="t-5")
		with self.assertRaises(frappe.ValidationError):
			REL.release_biological(GH, PP, 0, client_id="t-6")

	def test_release_makes_the_predator_present_for_the_check(self):
		_receipt(ITEM, self.store, 5, 120)
		REL.release_biological(GH, PP, 1, stage="Adult", client_id="t-7")
		ctx = C.build_context(greenhouse=GH, targets=[], mix=[])
		self.assertEqual([(p["predator"], p["source"]) for p in ctx["predators"]], [(PP, "released")])
		ctx2 = C.build_context(greenhouse="Karen GH 02 - KR", targets=[], mix=[])
		self.assertEqual(ctx2["predators"], [])


class TestHarmAgainstRealSpray(unittest.TestCase):
	"""A completed Chepsito GH 02 spray (17 Oct) carried emamectin benzoate: harmful to P. persimilis for ~21 days."""

	GHX = "Chepsito GH 02 - KR"
	WO = "MFG-WO-2026-05914"

	def setUp(self):
		frappe.set_user("Administrator")
		if not frappe.db.exists("Work Order", self.WO):
			self.skipTest("fixture spray not on this site")

	def tearDown(self):
		frappe.db.rollback()

	def test_release_after_a_harmful_spray_warns(self):
		w = REL.release_warnings(self.GHX, PP, "Adult", "2026-10-20 09:00:00")
		self.assertTrue(w and "Emamectin" in w[0] and "harmful" in w[0])
		self.assertEqual(REL.release_warnings(self.GHX, PP, "Adult", "2026-12-20 09:00:00"), [])
		self.assertEqual(REL.release_warnings("Karen GH 01 - KR", PP, None, "2026-10-20 09:00:00"), [])

	def test_spray_after_a_release_violates_and_modes_apply(self):
		doc = frappe.get_doc({"doctype": "Biological Release", "greenhouse": self.GHX, "predator": PP, "stage": "Adult",
		                      "quantity": 1, "uom": "Bottle", "released_at": "2026-10-19 08:00:00"})
		doc.flags.ignore_validate = True
		doc.insert(ignore_permissions=True)
		frappe.db.set_value("Biological Release", doc.name, "docstatus", 1)
		items = frappe.get_all("Work Order Item", filters={"parent": self.WO}, pluck="item_code")
		ctx = C.build_context(greenhouse=self.GHX, targets=[], mix=items, when="2026-10-24 09:00:00")
		self.assertTrue(any(e["source"] == "released" for e in ctx["predators"]))
		res = E.check_mix({**ctx, "modes": {**ctx["modes"], "predator_harm": "Warn"}})
		self.assertTrue([v for v in res["violations"] if v["rule"] == "predator_harm"])
		blocked = E.check_mix({**ctx, "modes": {**ctx["modes"], "predator_harm": "Block"}})
		self.assertEqual(blocked["status"], "Blocked")
		off = E.check_mix({**ctx, "modes": {**ctx["modes"], "predator_harm": "Off"}})
		self.assertFalse([v for v in off["violations"] if v["rule"] == "predator_harm"])
		# outside the presence window the predator no longer counts
		late = C.build_context(greenhouse=self.GHX, targets=[], mix=items, when="2026-12-30 09:00:00")
		self.assertEqual(late["predators"], [])
