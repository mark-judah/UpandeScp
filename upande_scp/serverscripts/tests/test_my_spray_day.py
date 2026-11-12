"""The "Today's sprays" endpoint: scoped to the caller and the site-local day.

Run: bench --site kaitet.local run-tests \
        --module upande_scp.serverscripts.tests.test_my_spray_day
"""
import unittest

import frappe

from upande_scp.serverscripts.spray_plan_creator import day_summary as DS


class TestUtcIso(unittest.TestCase):
	def test_naive_site_time_becomes_utc(self):
		frappe.local.site  # needs a site context for erp_timezone
		out = DS._utc_iso("2026-11-12 09:00:00")
		self.assertTrue(out.endswith("Z"))
		self.assertIsNone(DS._utc_iso(None))


class TestMySprayDay(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")

	def test_returns_the_shape_and_only_the_callers_sessions(self):
		out = DS.my_spray_day("2000-01-01")
		self.assertEqual(out["date"], "2000-01-01")
		self.assertEqual(out["sessions"], [])
		self.assertIn("item_names", out)

	def test_work_orders_arg_accepts_json_text(self):
		self.assertEqual(DS._as_list('["WO-1", "", "WO-2"]'), ["WO-1", "WO-2"])
		self.assertEqual(DS._as_list(None), [])

	def test_a_token_on_the_day_comes_back_with_utc_times_and_scans(self):
		item = frappe.db.get_value("Item", {}, "name")
		if not item:
			self.skipTest("no items on this site")
		tok = "test-day-summary-token"
		if frappe.db.exists("Spray Session Token", tok):
			frappe.delete_doc("Spray Session Token", tok, force=True)
		doc = frappe.new_doc("Spray Session Token")
		doc.token = tok
		doc.work_order = frappe.db.get_value("Work Order", {}, "name") or "WO-X"
		doc.started_at = "2031-05-04 08:00:00"
		doc.ended_at = "2031-05-04 09:30:00"
		doc.status = "Pending"
		doc.append("scans", {"item_code": item, "qty": 2})
		doc.flags.ignore_links = True
		doc.insert(ignore_permissions=True)
		try:
			out = DS.my_spray_day("2031-05-04")
			mine = [s for s in out["sessions"] if s["token"] == tok]
			self.assertEqual(len(mine), 1)
			self.assertTrue(mine[0]["started_at"].endswith("Z"))
			self.assertEqual(mine[0]["scans"][0]["qty"], 2)
			self.assertIn(item, out["item_names"])
			# a different day does not include it
			self.assertEqual(
				[s for s in DS.my_spray_day("2031-05-05")["sessions"] if s["token"] == tok], [])
		finally:
			frappe.db.rollback()
