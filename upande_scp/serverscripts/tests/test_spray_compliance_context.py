"""Context loader against kaitet.local. DB test — direct runner. Read-only."""

import unittest

import frappe

from upande_scp.serverscripts.spray_compliance import context as C
from upande_scp.serverscripts.spray_compliance.engine import RULES

# These tests pin the per-rule modes, so they run in Strict (a site in Warn softens targeting rules).
_strict = None


def setUpModule():
	global _strict
	from unittest import mock

	_strict = mock.patch("upande_scp.serverscripts.spray_compliance.targeting.mode", return_value="Strict")
	_strict.start()


def tearDownModule():
	_strict.stop()



class TestContext(unittest.TestCase):
	def test_products_read_codes_from_spray_product(self):
		item = frappe.db.sql("""select parent from `tabFRAC Code Filter`
		                        where parenttype='Spray Product' limit 1""")[0][0]
		p = C.load_products([item, "NO-SUCH-ITEM"])
		self.assertIn(item, p)
		self.assertNotIn("NO-SUCH-ITEM", p)
		self.assertTrue(p[item]["frac"])
		for k in ("name", "category", "type", "targets", "irac", "frac", "ingredients"):
			self.assertIn(k, p[item])

	def test_codes_come_live_from_linked_ingredients(self):
		if not frappe.db.exists("Active Ingredient MoA", "Azoxystrobin"):
			frappe.get_doc({"doctype": "Active Ingredient MoA", "ingredient": "Azoxystrobin",
			                "kind": "Fungicide", "frac_code": "11"}).insert(ignore_permissions=True)
		item = frappe.get_all("Spray Product", filters={"disabled": 0, "category": "Chemical"}, pluck="name", limit=1)[0]
		doc = frappe.get_doc("Spray Product", item)
		doc.set("frac", [])
		doc.set("active_ingredients", [{"active_ingredient": "Azoxystrobin", "concentration": 250,
		                                "concentration_unit": "g/L", "ingredient": "Azoxystrobin [250 g/L]"}])
		doc.save(ignore_permissions=True)
		p = C.load_products([item])[item]
		self.assertIn("11", p["frac"])
		self.assertEqual(p["ingredients"], ["Azoxystrobin"])
		frappe.db.rollback()

	def test_crop_for_a_rose_greenhouse(self):
		farms = [r.farm for r in frappe.get_doc("Crop Scouted", "Rose").farms]
		gh = frappe.db.get_value("Warehouse", {"custom_farm": ["in", farms], "is_group": 0}, "name")
		self.assertEqual(C.crop_for_greenhouse(gh), "Rose")
		self.assertEqual(C.crop_for_greenhouse("Nowhere"), "")

	def test_build_context_shape(self):
		c = C.build_context(greenhouse="Nowhere", targets=["Thrips"], mix=["X"])
		self.assertEqual(set(c["modes"]), set(RULES))
		self.assertEqual(c["history"], [])
		for k in ("alternate_moa", "max_sprays", "known_resistance"):
			self.assertIn(k, c["guidelines"])
		self.assertIn("now", c)

	def test_known_resistance_from_guidelines(self):
		c = C.build_context(greenhouse="Nowhere", targets=["Powdery Mildew"], mix=[])
		self.assertIn({"kind": "frac", "target": "Powdery Mildew", "code": "11"},
		              c["guidelines"]["known_resistance"])


class TestHistory(unittest.TestCase):
	GH = "ZZ-TEST-GH"

	def _wo(self, name, state, when, items, docstatus=1):
		frappe.db.sql("""insert into `tabWork Order` (name, creation, modified, owner, modified_by, docstatus,
		                 custom_type, custom_greenhouse, workflow_state, custom_scheduled_application_time)
		                 values (%s, now(), now(), 'Administrator', 'Administrator', %s,
		                 'Application Floor Plan', %s, %s, %s)""", (name, docstatus, self.GH, state, when))
		for i, it in enumerate(items, 1):
			frappe.db.sql("""insert into `tabWork Order Item` (name, creation, modified, owner, modified_by,
			                 docstatus, idx, parent, parenttype, parentfield, item_code)
			                 values (%s, now(), now(), 'Administrator', 'Administrator', 0, %s, %s,
			                 'Work Order', 'required_items', %s)""", (f"{name}-{i}", i, name, it))

	def test_history_filters_and_grouping(self):
		from frappe.utils import add_days, now_datetime
		now = now_datetime()
		self._wo("ZZ-WO-OK", "Completed", add_days(now, -2), ["A", "B"])
		self._wo("ZZ-WO-DIRECT", "Chemicals Issued Direct", add_days(now, -1), ["C"])
		self._wo("ZZ-WO-DRAFT", "Awaiting Approval", add_days(now, -1), ["D"])
		self._wo("ZZ-WO-OLD", "Completed", add_days(now, -4000), ["E"])
		self._wo("ZZ-WO-FUTURE", "Approved", add_days(now, 3), ["F"])
		self._wo("ZZ-WO-SELF", "Approved", add_days(now, -3), ["G"])
		h = C.load_history(self.GH, "", when=now)
		self.assertEqual([x["wo"] for x in h], ["ZZ-WO-SELF", "ZZ-WO-OK", "ZZ-WO-DIRECT"])
		self.assertEqual(h[1]["items"], ["A", "B"])
		h = C.load_history(self.GH, "", exclude_wo="ZZ-WO-SELF", when=now)
		self.assertEqual([x["wo"] for x in h], ["ZZ-WO-OK", "ZZ-WO-DIRECT"])
		# Anchored at a plan five days out, the approved spray due in three days is history.
		h = C.load_history(self.GH, "", exclude_wo="ZZ-WO-SELF", when=add_days(now, 5))
		self.assertEqual([x["wo"] for x in h], ["ZZ-WO-OK", "ZZ-WO-DIRECT", "ZZ-WO-FUTURE"])
		frappe.db.rollback()

	def test_rotation_counts_approved_sprays_due_before_the_plan(self):
		"""Plans are batched ahead: a same-group spray approved for later this week
		must count against a plan scheduled after it."""
		from frappe.utils import add_days, now_datetime
		from upande_scp.serverscripts.spray_compliance import engine as E
		from upande_scp.serverscripts.spray_compliance import rules as R
		parents = frappe.db.sql_list("""select distinct parent from `tabFRAC Code Filter`
		                                where parenttype='Spray Product' limit 50""")
		products = C.load_products(parents)
		item = next(i for i, p in products.items() if any(R._counts(c) for c in p["frac"]))
		now = now_datetime()
		self._wo("ZZ-WO-SOON", "Approved", add_days(now, 2), [item])
		plan_at = add_days(now, 6)

		def rotation(when):
			ctx = C.build_context(greenhouse=self.GH, targets=["Thrips"], mix=[item], crop="", when=when)
			ctx["guidelines"]["alternate_moa"] = {"irac": 1, "frac": 1}
			ctx["modes"] = {r: E.OFF for r in E.RULES} | {"moa_rotation": E.WARN}
			return [v for v in E.check_mix(ctx)["violations"] if v["rule"] == "moa_rotation"]

		try:
			self.assertTrue(rotation(plan_at), "the spray due before the plan was not counted")
			self.assertEqual(C.build_context(greenhouse=self.GH, targets=[], mix=[], crop="", when=plan_at)["now"],
			                 plan_at.strftime("%Y-%m-%d %H:%M:%S"))
			self.assertFalse(rotation(None))  # judged at "now", the later spray is not history yet
		finally:
			frappe.db.rollback()

	def test_targets_are_stripped(self):
		c = C.build_context(greenhouse="Nowhere", targets=["Thrips\r", " ", "", " Mites "], mix=[])
		self.assertEqual(c["targets"], ["Thrips", "Mites"])
