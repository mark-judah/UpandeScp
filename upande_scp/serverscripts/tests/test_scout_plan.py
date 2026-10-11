"""The weekly scout plan against the database. Rolled back.

* save replaces the farm's week; the unique (date, scout, greenhouse) holds;
* a scout on approved leave is refused, pending leave only warns;
* a farm outside the user's scope, or a house outside the farm, is refused;
  read-only roles see the plan but cannot save;
* Done / Missed / unplanned come from crafted Scouting Entries.

The crafted entries sit in a week of 2020 so no real data or warm partial is
touched; the dates' quality partials are dropped again in tearDown.
"""

import unittest
from unittest import mock

import frappe

from upande_scp.serverscripts.common import cache_utils
from upande_scp.serverscripts.common import scout_plan_rules as R
from upande_scp.serverscripts.scouting import scouting_metrics
from upande_scp.serverscripts.scouts import scout_plan as SP

WEEK = "2020-01-06"  # a Monday
TUE, WED, THU = "2020-01-07", "2020-01-08", "2020-01-09"


class TestScoutPlan(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		farms_map = scouting_metrics.get_farms_and_warehouses() or {}
		rose = set(frappe.get_all("Farm Filter", filters={"parenttype": "Crop Scouted", "parent": "Rose"},
								  pluck="farm"))
		farms = sorted(f for f, hs in farms_map.items() if f in rose and len(hs) >= 3)
		if not farms:
			self.skipTest("no Rose farm with three houses")
		self.farm = farms[0]
		self.houses = farms_map[self.farm][:3]
		self.other_house = next(h for f, hs in farms_map.items() if f != self.farm for h in hs)
		emps = frappe.db.sql(
			"""SELECT e.name, e.employee_name, e.company FROM tabEmployee e
			    WHERE e.status='Active' AND NOT EXISTS (
			          SELECT 1 FROM `tabLeave Application` l WHERE l.employee=e.name
			             AND l.from_date <= '2020-01-12' AND l.to_date >= '2020-01-06' AND l.docstatus < 2)
			    LIMIT 2""",
			as_dict=True,
		)
		if len(emps) < 2:
			self.skipTest("need two employees")
		self.a, self.b = emps
		frappe.db.delete("Scout Assignment", {"date": ["between", ["2019-12-30", "2020-01-12"]]})

	def tearDown(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")
		cache_utils.invalidate_quality_days(*[str(d) for d in R.week_days(WEEK)])

	# ── helpers ──
	def _save(self, rows, **kw):
		return SP.save_scout_plan(crop="Rose", farm=self.farm, week_start=WEEK, assignments=rows, **kw)

	def _row(self, day, emp, house):
		return {"date": day, "scout": emp["name"], "greenhouse": house}

	def _entry(self, name, day, emp, house):
		doc = frappe.new_doc("Scouting Entry")
		doc.update({"date_of_capture": day, "time_of_capture": "08:00:00", "greenhouse": house,
					"crop_scouted": "Rose", "scouts_name": emp["name"]})
		doc.name = name
		doc.db_insert()

	def _leave(self, name, emp, day, status="Approved", docstatus=1):
		leave = frappe.new_doc("Leave Application")
		leave.update({"employee": emp["name"], "employee_name": emp["employee_name"],
					  "leave_type": frappe.db.get_value("Leave Type", {}, "name") or "Annual Leave",
					  "from_date": day, "to_date": day, "status": status, "docstatus": docstatus,
					  "company": emp["company"]})
		leave.name = name
		leave.db_insert()

	# ── tests ──
	def test_save_then_replace_the_week(self):
		out = self._save([self._row(TUE, self.a, self.houses[0]), self._row(WED, self.b, self.houses[1]),
						  self._row(WED, self.b, self.houses[1])])  # duplicate collapses
		self.assertEqual(out["saved"], 2)
		self.assertEqual(frappe.db.count("Scout Assignment", {"farm": self.farm, "date": ["between", ["2020-01-06", "2020-01-12"]]}), 2)
		row = frappe.get_all("Scout Assignment", filters={"scout": self.a["name"], "date": TUE},
							 fields=["farm", "crop", "scout_name"])[0]
		self.assertEqual((row["farm"], row["crop"]), (self.farm, "Rose"))
		self._save([self._row(THU, self.a, self.houses[2])])
		got = SP.get_scout_plan(crop="Rose", farm=self.farm, week_start=THU)
		self.assertEqual(got["weekStart"], WEEK)
		self.assertEqual([(a["date"], a["greenhouse"]) for a in got["assignments"]], [(THU, self.houses[2])])
		self.assertIn(self.houses[0], got["check"]["unplanned"])

	def test_unique_index_refuses_a_second_row(self):
		self._save([self._row(TUE, self.a, self.houses[0])])
		dup = frappe.get_doc({"doctype": "Scout Assignment", "date": TUE, "scout": self.a["name"],
							  "greenhouse": self.houses[0], "farm": self.farm})
		with self.assertRaises(frappe.DuplicateEntryError):
			dup.insert(ignore_permissions=True)

	def test_approved_leave_is_refused_pending_only_warns(self):
		self._leave("TEST-SP-LEAVE-1", self.b, WED)
		with self.assertRaises(frappe.ValidationError) as ctx:
			self._save([self._row(WED, self.b, self.houses[1])])
		self.assertIn("approved leave", str(ctx.exception))
		self.assertEqual(frappe.db.count("Scout Assignment", {"farm": self.farm, "date": WED}), 0)
		self._leave("TEST-SP-LEAVE-2", self.a, THU, status="Open", docstatus=0)
		out = self._save([self._row(THU, self.a, self.houses[0]), self._row(TUE, self.b, self.houses[1])])
		self.assertEqual(out["saved"], 2)
		self.assertTrue(any("pending" in w for w in out["warnings"]))
		self.assertEqual(out["leaves"][self.b["name"]][WED], "on_leave")
		self.assertEqual(out["leaves"][self.a["name"]][THU], "leave_pending")

	def test_scope_and_house_refusals(self):
		with self.assertRaises(frappe.PermissionError):
			self._save([self._row(TUE, self.a, self.other_house)])
		with mock.patch.object(SP.farm_scope.__globals__["crop_scope"], "visible_farms", return_value=set()):
			with self.assertRaises(frappe.PermissionError):
				self._save([self._row(TUE, self.a, self.houses[0])])
			with self.assertRaises(frappe.PermissionError):
				SP.get_scout_plan(crop="Rose", farm=self.farm, week_start=WEEK)
		with self.assertRaises(frappe.ValidationError):
			self._save([self._row("2020-01-13", self.a, self.houses[0])])  # next week

	def test_read_only_roles_see_but_cannot_save(self):
		with mock.patch.object(SP, "_roles", return_value={"SCP Spray Supervisor"}):
			got = SP.get_scout_plan(crop="Rose", farm=self.farm, week_start=WEEK)
			self.assertFalse(got["canEdit"])
			with self.assertRaises(frappe.PermissionError):
				self._save([self._row(TUE, self.a, self.houses[0])])
		with mock.patch.object(SP, "_roles", return_value={"Employee"}):
			with self.assertRaises(frappe.PermissionError):
				SP.get_scout_plan(crop="Rose", farm=self.farm, week_start=WEEK)

	def test_done_missed_and_unplanned_from_entries(self):
		self._entry("TEST-SP-SE-1", TUE, self.a, self.houses[0])
		self._entry("TEST-SP-SE-2", TUE, self.b, self.houses[2])  # nobody planned this
		cache_utils.invalidate_quality_days(TUE)
		out = self._save([self._row(TUE, self.a, self.houses[0]), self._row(WED, self.b, self.houses[1])])
		status = {(a["date"], a["scout"]): a["status"] for a in out["assignments"]}
		self.assertEqual(status[(TUE, self.a["name"])], R.DONE)
		self.assertEqual(status[(WED, self.b["name"])], R.MISSED)
		self.assertEqual([(u["scout"], u["greenhouse"]) for u in out["unplanned"]], [(self.b["name"], self.houses[2])])
		stored = frappe.db.get_value("Scout Assignment", {"date": TUE, "scout": self.a["name"]}, "status")
		self.assertEqual(stored, R.DONE)
		self.assertIn(self.a["name"], {s["scout"] for s in out["scouts"]})

	# ── C9: scouting respects approved leave ──
	def test_leave_approved_after_saving_shows_on_leave_and_asks_to_reassign(self):
		self._save([self._row(WED, self.b, self.houses[1]), self._row(WED, self.b, self.houses[2]),
					self._row(TUE, self.a, self.houses[0])])
		self._leave("TEST-SP-LEAVE-3", self.b, WED)  # approved after the plan
		got = SP.get_scout_plan(crop="Rose", farm=self.farm, week_start=WEEK)
		status = {(a["date"], a["scout"], a["greenhouse"]): a["status"] for a in got["assignments"]}
		self.assertEqual(status[(WED, self.b["name"], self.houses[1])], R.ON_LEAVE)
		self.assertEqual(status[(TUE, self.a["name"], self.houses[0])], R.MISSED)
		self.assertEqual(
			got["check"]["onLeave"],
			[{"scout": self.b["name"], "date": WED, "greenhouse": h} for h in sorted(self.houses[1:3])],
		)

	def test_ranking_excuses_approved_leave_days(self):
		from upande_scp.serverscripts.scouts import api as SA

		self._leave("TEST-SP-LEAVE-4", self.a, "2020-01-01")
		lv = frappe.new_doc("Leave Application")
		lv.update({"employee": self.a["name"], "leave_type": frappe.db.get_value("Leave Type", {}, "name") or "Annual Leave",
				   "from_date": "2020-01-03", "to_date": "2020-01-20", "status": "Approved", "docstatus": 1,
				   "company": self.a["company"]})
		lv.name = "TEST-SP-LEAVE-5"
		lv.db_insert()
		self._leave("TEST-SP-LEAVE-6", self.b, "2020-01-02", status="Open", docstatus=0)  # pending: not excused
		days = SA.approved_leave_days([self.a["name"], self.b["name"]], "2020-01-01", "2020-01-14")
		self.assertEqual(days, {self.a["name"]: 13.0})  # the 1st + the 3rd–14th

		row = {"scout": self.a["name"], "scoutName": "A", "entries": 50, "activeDays": 2, "stationsPerDay": 5.0,
			   "tooFastPct": 0, "duplicatePct": 0, "offZonePct": 0, "houseOffZonePct": 0, "fixes": 10,
			   "entriesPerHour": None, "nothingFoundPct": None, "houses": [{"house": self.houses[0], "entries": 50}]}
		fake = {"scouts": [row, {**row, "scout": self.b["name"]}], "flags": [],
				"range": {"from_date": "2020-01-01", "to_date": "2020-01-14"}, "clamped": False}
		with mock.patch.object(SA._quality, "quality", return_value=fake):
			out = SA.get_scouts(crop="Rose", farm=self.farm, from_date="2020-01-01", to_date="2020-01-14")
		# 14-day range, 13 on leave: 1 active day suffices; B (pending only) still needs 5
		self.assertEqual([r["scout"] for r in out["ranked"]], [self.a["name"]])
		self.assertEqual(out["ranked"][0]["leaveDays"], 13.0)
		self.assertEqual(out["notEnoughDays"][0]["leaveDays"], 0)
