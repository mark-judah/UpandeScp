"""API endpoints on kaitet.local. DB test — direct runner. Read-only."""

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
		for k in ("eligible", "status", "coverage", "reasons"):
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
