"""API endpoints on kaitet.local. DB test — direct runner. Writes are rolled back."""

import unittest

import frappe

from upande_scp.serverscripts.spray_compliance import api


def _product_for(target):
	return frappe.db.sql("""select parent from `tabChemical Targets` where parenttype='Spray Product'
	                        and (pest=%s or disease=%s) limit 1""", (target, target))[0][0]


class TestApi(unittest.TestCase):
	def test_check_spray_plan_shape(self):
		pm = _product_for("Powdery Mildew")
		r = api.check_spray_plan("Nowhere", '["Powdery Mildew", "Thrips"]', f'["{pm}"]')
		self.assertEqual(r["coverage"][0], {"target": "Powdery Mildew", "products": [pm]})
		self.assertIn("target_coverage", {v["rule"] for v in r["violations"]})

	def test_eligible_products_puts_the_match_first(self):
		pm = _product_for("Powdery Mildew")
		rows = api.eligible_products("Nowhere", ["Powdery Mildew"], [], [pm, "NO-SUCH"])
		self.assertTrue(rows[0]["eligible"] and rows[0]["item"] == pm)
		self.assertFalse(rows[1]["eligible"])

	def test_eligible_boms(self):
		bom = frappe.db.get_value("BOM", {"docstatus": 1, "is_active": 1}, "name")
		rows = api.eligible_boms("Nowhere", ["Thrips"], [bom])
		self.assertEqual(rows[0]["bom"], bom)
		for k in ("eligible", "status", "coverage", "reasons", "untargeted"):
			self.assertIn(k, rows[0])

	def test_can_override(self):
		self.assertTrue(api.can_override("Administrator"))
		self.assertFalse(api.can_override("Guest"))

	def test_overrides_ignored_without_permission(self):
		pm = _product_for("Powdery Mildew")
		ov = '[{"key": "x", "reason": "r"}]'
		orig = frappe.session.user
		try:
			frappe.set_user("Guest")
			self.assertFalse(api.check_spray_plan("Nowhere", '["Thrips"]', f'["{pm}"]', ov)["can_override"])
			seen = []
			real = api.E.check_mix
			api.E.check_mix = lambda ctx, o=(): (seen.append(o), real(ctx, o))[1]
			try:
				api.check_spray_plan("Nowhere", '["Thrips"]', f'["{pm}"]', ov)
				api.result_for_payload({"custom_greenhouse": "Nowhere", "spray_rule_overrides": [{"key": "x", "reason": "r"}]})
			finally:
				api.E.check_mix = real
			self.assertEqual(seen, [[], []])
		finally:
			frappe.set_user(orig)


class TestAnchor(unittest.TestCase):
	"""Every entry point judges a plan at its own spray time, not at "now"."""

	def _when_passed(self, fn):
		from unittest import mock
		from upande_scp.serverscripts.spray_compliance import context as C
		real = C.build_context
		seen = []

		def spy(**kw):
			seen.append(kw.get("when"))
			return real(**kw)

		with mock.patch.object(C, "build_context", side_effect=spy):
			fn()
		return seen

	def test_endpoints_and_save_pass_the_spray_time(self):
		t = "2026-12-01 06:00:00"
		bom = frappe.db.get_value("BOM", {"docstatus": 1, "is_active": 1}, "name")
		self.assertEqual(self._when_passed(lambda: api.check_spray_plan("Nowhere", "[]", "[]", when=t)), [t])
		self.assertEqual(self._when_passed(lambda: api.eligible_products("Nowhere", "[]", "[]", "[]", when=t)), [t])
		self.assertEqual(self._when_passed(lambda: api.eligible_boms("Nowhere", "[]", [bom], when=t)), [t])
		payload = {"custom_greenhouse": "Nowhere", "custom_targets": [], "chemicals": [],
		           "custom_scheduled_application_time": t}
		self.assertEqual(self._when_passed(lambda: api.result_for_payload(payload)), [t])

	def test_a_wo_is_judged_at_its_scheduled_time(self):
		from upande_scp.serverscripts.spray_compliance import context as C
		wo = frappe.new_doc("Work Order")
		wo.custom_greenhouse, wo.custom_targets, wo.name = "Nowhere", "Thrips", "TEST-WO-NOT-SAVED"
		wo.custom_scheduled_application_time = "2026-12-01 06:00:00"
		self.assertEqual(C.context_for_wo(wo)["now"], "2026-12-01 06:00:00")

	def test_save_payload_carries_the_spray_time(self):
		from upande_scp.serverscripts.spray_plan_creator import drafts
		wo = frappe.new_doc("Work Order")
		wo.custom_greenhouse, wo.custom_targets = "Nowhere", "Thrips"
		wo.custom_scheduled_application_time = "2026-12-01 06:00:00"
		p = drafts._compliance_payload(wo, {})
		self.assertEqual(p["custom_scheduled_application_time"], "2026-12-01 06:00:00")


class TestUntargetedNeverOffered(unittest.TestCase):
	"""A pest-control product with no registered target is filtered on the
	server: not in the chemical search, not ranked, and no tank mix carrying it
	is listed. Strips one real product's targets and rolls back."""

	def setUp(self):
		from upande_scp.serverscripts.common.crop_protection import product_groups
		row = frappe.db.sql("""select sp.item, b.parent bom from `tabSpray Product` sp
		                       join `tabItem` i on i.name=sp.item and i.disabled=0 and i.item_group in %(g)s
		                       join `tabBOM Item` b on b.item_code=sp.item
		                       join `tabBOM` bm on bm.name=b.parent and bm.is_active=1 and bm.docstatus=1
		                       where sp.category='Chemical' and exists (select 1 from `tabChemical Targets` t
		                             where t.parenttype='Spray Product' and t.parent=sp.name)
		                       limit 1""", {"g": tuple(product_groups())}, as_dict=True)
		if not row:
			self.skipTest("no targeted chemical in an active tank mix")
		self.item, self.bom = row[0].item, row[0].bom

	def tearDown(self):
		frappe.db.rollback()

	def _offered(self):
		from upande_scp.serverscripts.scouting.scouting_metrics_api import list_chemical_items
		from upande_scp.serverscripts.spray_compliance import context as C
		return {
			"search": self.item in [r["item_code"] for r in list_chemical_items(q=self.item)],
			"ranked": self.item in [r["item"] for r in api.eligible_products("Nowhere", ["Thrips"], [], [self.item])],
			"bom": self.bom in [r["bom"] for r in api.eligible_boms("Nowhere", ["Thrips"], [self.bom])],
			"bom_listed": self.bom not in C.boms_with_untargeted([self.bom]),
		}

	def test_targeted_product_is_offered(self):
		self.assertEqual(self._offered(), {"search": True, "ranked": True, "bom": True, "bom_listed": True})

	def test_untargeted_product_is_not_fetched(self):
		frappe.db.sql("delete from `tabChemical Targets` where parenttype='Spray Product' and parent=%s", self.item)
		self.assertEqual(self._offered(), {"search": False, "ranked": False, "bom": False, "bom_listed": False})
