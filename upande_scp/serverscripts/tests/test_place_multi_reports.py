"""Endpoints that take one farm or several (JSON list / comma names), and still one.

Plain unittest against the site's own data: every check compares the multi-farm answer
with the single-farm answers it must be made of.
"""
import json
import unittest

import frappe

from upande_scp.serverscripts.spray_plan_creator.loaning_v2 import narrow_farms


def _farms(n=2):
	rows = frappe.db.sql(
		"SELECT DISTINCT custom_farm FROM `tabWarehouse` WHERE IFNULL(custom_farm, '') != '' ORDER BY custom_farm LIMIT %s",
		(n,),
	)
	return [r[0] for r in rows]


class TestNarrowFarms(unittest.TestCase):
	def test_elevated_user_no_limit(self):
		self.assertIsNone(narrow_farms(None, None))
		self.assertIsNone(narrow_farms(None, "__all__"))
		self.assertEqual(narrow_farms(None, "A"), ["A"])
		self.assertEqual(narrow_farms(None, '["A","B"]'), ["A", "B"])

	def test_planner_is_intersected_with_own_farms(self):
		self.assertEqual(sorted(narrow_farms({"A", "B"}, None)), ["A", "B"])
		self.assertEqual(narrow_farms(["A", "B"], "A"), ["A"])
		self.assertEqual(narrow_farms(["A", "B"], "A,C"), ["A"])
		self.assertEqual(narrow_farms(["A"], "C"), [])
		self.assertEqual(narrow_farms([], None), [])


class TestPlaceMultiEndpoints(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.flags.in_test = True
		frappe.set_user("Administrator")
		cls.farms = _farms(2)

	def _need_two(self):
		if len(self.farms) < 2:
			self.skipTest("needs two farms on the site")

	def test_it_monitor_devices_union(self):
		from upande_scp.serverscripts.it_monitor import dashboard as D

		self._need_two()
		a, b = self.farms
		ids = lambda farm: {r["install_id"] for r in D.devices(farm=farm)}  # noqa: E731
		self.assertEqual(ids(json.dumps([a, b])), ids(a) | ids(b))
		self.assertEqual(ids(f"{a},{b}"), ids(a) | ids(b))
		self.assertEqual(ids(""), {r["install_id"] for r in D.devices()})

	def test_it_monitor_overview_and_flow_accept_lists(self):
		from upande_scp.serverscripts.it_monitor import dashboard as D

		self._need_two()
		a, b = self.farms
		both = json.dumps([a, b])
		ov = D.overview(7, both)
		self.assertEqual(ov["devices"]["total"], D.overview(7, a)["devices"]["total"] + D.overview(7, b)["devices"]["total"])
		D.logins(7, both)
		flow = D.data_flow(7, both)
		one = sum(d["scouting_entries"] for d in D.data_flow(7, a)["daily"])
		two = sum(d["scouting_entries"] for d in D.data_flow(7, b)["daily"])
		self.assertEqual(sum(d["scouting_entries"] for d in flow["daily"]), one + two)

	def test_fcm_report_weeks_union(self):
		from upande_scp.serverscripts.reports.send_fcm_weekly_excel_report import list_report_weeks

		self._need_two()
		a, b = self.farms
		weeks = lambda farm: {w["week"] for w in list_report_weeks(farm)}  # noqa: E731
		self.assertEqual(weeks(json.dumps([a, b])), weeks(a) | weeks(b))
		self.assertEqual(list_report_weeks(""), [])

	def test_block_report_weeks_union(self):
		from upande_scp.serverscripts.reports.block_weekly_report import report_weeks

		self._need_two()
		a, b = self.farms
		key = lambda farm: {(w["year"], w["week"]) for w in report_weeks("Avocado", farm, limit=500)}  # noqa: E731
		self.assertEqual(key(json.dumps([a, b])), key(a) | key(b))

	def test_open_alerts_accepts_lists(self):
		from upande_scp.serverscripts.scouting.thresholds_check import open_alerts

		self._need_two()
		a, b = self.farms
		names = lambda farm: {r["name"] for r in open_alerts("Rose", farm=farm)}  # noqa: E731
		self.assertEqual(names(json.dumps([a, b])), names(a) | names(b))

	def test_list_requests_v2_farm_filter(self):
		from upande_scp.serverscripts.spray_plan_creator.loaning_v2 import list_requests_v2

		self._need_two()
		a, b = self.farms
		for box in ("incoming", "outgoing"):
			names = lambda farm: {r["name"] for r in list_requests_v2(box, farm)}  # noqa: E731
			self.assertEqual(names(json.dumps([a, b])), names(a) | names(b))
