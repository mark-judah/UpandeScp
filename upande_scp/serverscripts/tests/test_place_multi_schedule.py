"""Farm filters of the schedule, tank-mix list and open-alerts endpoints take one
name or several (JSON list / comma names), and still take a single name."""
import json
import unittest

import frappe

from upande_scp.serverscripts.scouting import scouting_metrics_api as tm
from upande_scp.serverscripts.spray_plan_ops import schedule as sched


class TestPlaceMultiSchedule(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.flags.in_test = True
		frappe.set_user("Administrator")
		cls.farms = [f for f in frappe.get_all("Farm", pluck="name") if frappe.db.exists("Warehouse", {"custom_farm": f})][:2]

	def test_schedule_greenhouses_single_and_several(self):
		if len(self.farms) < 2:
			self.skipTest("needs two farms with warehouses")
		a, b = self.farms
		one, _ = sched._greenhouses(None, a)
		self.assertTrue(one and set(one.values()) == {a})
		many, _ = sched._greenhouses(None, json.dumps([a, b]))
		self.assertEqual(set(many.values()), {a, b})
		comma, _ = sched._greenhouses(None, f"{a},{b}")
		self.assertEqual(comma, many)
		everything, _ = sched._greenhouses(None, "")
		self.assertTrue(set(many) <= set(everything))

	def test_tank_mixes_accept_a_list(self):
		if len(self.farms) < 2:
			self.skipTest("needs two farms")
		a, b = self.farms
		both = tm.list_tank_mixes(farm=json.dumps([a, b]), active_only=0)
		only_a = tm.list_tank_mixes(farm=a, active_only=0)
		only_b = tm.list_tank_mixes(farm=b, active_only=0)
		got = {m["name"] for m in both["tank_mixes"]}
		self.assertEqual(got, {m["name"] for m in only_a["tank_mixes"]} | {m["name"] for m in only_b["tank_mixes"]})
		self.assertTrue({m.get("custom_farm") for m in both["tank_mixes"]} <= {a, b})

	def test_open_alerts_accept_lists(self):
		from upande_scp.serverscripts.scouting import thresholds_check as tc

		crop = (frappe.get_all("Crop Scouted", limit=1, pluck="name") or [None])[0]
		if not crop or not self.farms:
			self.skipTest("no crop or farm")
		everything = tc.open_alerts(crop)
		scoped = tc.open_alerts(crop, farm=json.dumps(self.farms))
		self.assertTrue({r.name for r in scoped} <= {r.name for r in everything})
		self.assertTrue({r.farm for r in scoped} <= set(self.farms))
		houses = [r.warehouse for r in everything if r.warehouse][:2]
		if houses:
			by_house = tc.open_alerts(crop, greenhouse=json.dumps(houses))
			self.assertTrue({r.warehouse for r in by_house} <= set(houses))
