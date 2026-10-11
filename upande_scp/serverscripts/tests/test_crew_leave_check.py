"""Crew leave check at the enforcement points, and the Schedule payload. Rolled back.

* Block: ``update_work_order_team`` refuses an on-leave member and writes nothing.
* Warn: it saves, comments on the Work Order and returns the warnings.
* Offline: never refuses, even in Block; the warning lands on the token.
* Planning only warns.
* ``get_schedule`` scopes to visible farms and flags plans whose crew is on leave.
"""

import unittest
from unittest import mock

import frappe
from frappe.utils import getdate

from upande_scp.serverscripts.common import crew_availability as CA
from upande_scp.serverscripts.spray_plan_creator import offline_session as OS
from upande_scp.serverscripts.spray_plan_creator import spray_session as SS
from upande_scp.serverscripts.spray_plan_ops import schedule as SCH

SINGLE = "Scouting and Crop Protection Settings"


class TestCrewLeaveCheck(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		row = frappe.db.sql(
			"""SELECT name, planned_start_date, custom_greenhouse FROM `tabWork Order`
			    WHERE custom_type='Application Floor Plan' AND docstatus=1
			      AND planned_start_date IS NOT NULL AND custom_greenhouse IS NOT NULL
			 ORDER BY planned_start_date DESC LIMIT 1""",
			as_dict=True,
		)
		if not row:
			self.skipTest("no floor plans on this site")
		self.wo = row[0]["name"]
		self.day = getdate(row[0]["planned_start_date"])
		self.greenhouse = row[0]["custom_greenhouse"]
		emps = frappe.db.sql(
			"""SELECT e.name, e.employee_name FROM tabEmployee e
			    WHERE e.status='Active' AND NOT EXISTS (
			          SELECT 1 FROM `tabLeave Application` l WHERE l.employee=e.name
			             AND l.from_date <= %s AND l.to_date >= %s AND l.docstatus < 2)
			    LIMIT 2""",
			(self.day, self.day),
			as_dict=True,
		)
		if len(emps) < 2:
			self.skipTest("need two employees without leave")
		self.away, self.here = emps[0], emps[1]
		leave = frappe.new_doc("Leave Application")
		leave.update({
			"employee": self.away["name"],
			"employee_name": self.away["employee_name"],
			"leave_type": frappe.db.get_value("Leave Type", {}, "name") or "Annual Leave",
			"from_date": self.day,
			"to_date": self.day,
			"status": "Approved",
			"docstatus": 1,
			"company": frappe.db.get_value("Employee", self.away["name"], "company"),
		})
		leave.name = "TEST-CREW-LEAVE-0001"
		leave.db_insert()
		self.team = [
			{"id": self.away["name"], "name": self.away["employee_name"], "role": "Sprayer"},
			{"id": self.here["name"], "name": self.here["employee_name"], "role": "Supervisor"},
		]
		self.crew_before = frappe.get_all(
			"Custom Spray Plan Team Member",
			filters={"parent": self.wo, "parentfield": "custom_spray_plan_team_members"},
			pluck="employee",
		)

	def tearDown(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")

	def _mode(self, mode, checkin=0):
		frappe.db.set_single_value(SINGLE, "crew_leave_check", mode)
		frappe.db.set_single_value(SINGLE, "crew_require_checkin", checkin)

	def _comments(self):
		return frappe.get_all(
			"Comment",
			filters={"reference_doctype": "Work Order", "reference_name": self.wo,
					 "content": ["like", "Crew check:%"]},
			pluck="content",
		)

	def test_availability_sees_the_leave(self):
		self._mode("Warn")
		out = SS.get_crew_availability(employees=[self.away["name"], self.here["name"]], on_date=str(self.day))
		self.assertEqual(out["members"][self.away["name"]]["status"], CA.ON_LEAVE)
		self.assertEqual(out["members"][self.here["name"]]["status"], CA.OK)

	def test_block_refuses_an_on_leave_member_and_writes_nothing(self):
		self._mode("Block")
		with self.assertRaises(frappe.ValidationError) as ctx:
			SS.update_work_order_team(self.wo, self.team)
		self.assertIn(self.away["employee_name"], str(ctx.exception))
		after = frappe.get_all(
			"Custom Spray Plan Team Member",
			filters={"parent": self.wo, "parentfield": "custom_spray_plan_team_members"},
			pluck="employee",
		)
		self.assertEqual(sorted(after), sorted(self.crew_before))

	def test_block_lets_an_available_crew_through(self):
		self._mode("Block")
		out = SS.update_work_order_team(self.wo, self.team[1:])
		self.assertTrue(out["success"])
		self.assertEqual(out["crew_warnings"], [])

	def test_warn_saves_comments_and_returns_warnings(self):
		self._mode("Warn")
		out = SS.update_work_order_team(self.wo, self.team)
		self.assertTrue(out["success"])
		self.assertEqual(out["members"], 2)
		self.assertEqual(len(out["crew_warnings"]), 1)
		self.assertIn("approved leave", out["crew_warnings"][0])
		comments = self._comments()
		self.assertEqual(len(comments), 1)
		self.assertIn(self.away["employee_name"], comments[0])
		# a second confirmation does not repeat the comment
		SS.update_work_order_team(self.wo, self.team)
		self.assertEqual(len(self._comments()), 1)

	def test_off_checks_nothing(self):
		self._mode("Off")
		out = SS.update_work_order_team(self.wo, self.team)
		self.assertEqual(out["crew_warnings"], [])
		self.assertEqual(self._comments(), [])

	def test_offline_replay_never_refuses_even_in_block(self):
		self._mode("Block")
		out = SS.update_work_order_team(self.wo, self.team, enforce_leave=False)
		self.assertTrue(out["success"])
		self.assertEqual(len(out["crew_warnings"]), 1)
		# the start path's check, as the replay calls it (enforce_cutoff=False)
		res = SS._check_crew(self.wo, [self.away["name"]], self.day, can_block=False)
		self.assertEqual(res["blocked"], [])
		self.assertEqual(len(res["messages"]), 1)
		with self.assertRaises(frappe.ValidationError):
			SS._check_crew(self.wo, [self.away["name"]], self.day, can_block=True)

	def test_offline_sync_records_the_warning_on_the_token(self):
		token = frappe.get_doc({
			"doctype": OS.TOKEN, "token": "TEST-CREW-TOKEN-1", "work_order": self.wo,
			"status": "Pending",
		})
		token.flags.ignore_links = True
		token.insert(ignore_permissions=True)
		OS._stamp_result(token.name, self.wo, {"crew_warnings": ["X was on approved leave on 2026-09-03."]})
		self.assertIn("approved leave", frappe.db.get_value(OS.TOKEN, token.name, "crew_warnings"))
		self.assertIn("crew_warnings", OS._result(token.name))

	def test_require_checkin_flags_a_member_with_no_in_punch(self):
		self._mode("Block", checkin=1)
		out = SS.get_crew_availability(employees=[self.here["name"]], on_date="2001-01-01")
		self.assertEqual(out["members"][self.here["name"]]["status"], CA.NOT_CHECKED_IN)
		with self.assertRaises(frappe.ValidationError):
			SS._check_crew(self.wo, [self.here["name"]], "2001-01-01", can_block=True)

	def test_planning_only_warns(self):
		from upande_scp.serverscripts.spray_plan_creator import drafts

		self._mode("Block")
		wo = frappe.get_doc("Work Order", self.wo)
		wo.planned_start_date = self.day
		wo.set("custom_spray_plan_team_members", [{"employee": self.away["name"], "role": "Sprayer"}])
		msgs = drafts._crew_warnings(wo)
		self.assertEqual(len(msgs), 1)
		self.assertIn("approved leave", msgs[0])

	def test_settings_bundle_carries_the_two_fields(self):
		from upande_scp.serverscripts.spray_plan_creator import settings

		self._mode("Block", checkin=1)
		sp = settings.get_settings_bundle()["spray_plan"]
		self.assertEqual(sp["crew_leave_check"], "Block")
		self.assertEqual(sp["crew_require_checkin"], 1)

	def test_schedule_flags_the_plan_and_lists_the_leave(self):
		self._mode("Off")
		SS.update_work_order_team(self.wo, self.team)
		out = SCH.get_schedule(from_date=str(self.day), to_date=str(self.day))
		plan = next(p for p in out["plans"] if p["name"] == self.wo)
		self.assertGreaterEqual(plan["on_leave_count"], 1)
		away = next(m for m in plan["crew"] if m["employee"] == self.away["name"])
		self.assertEqual(away["status"], CA.ON_LEAVE)
		leave = next(lv for lv in out["leaves"] if lv["name"] == "TEST-CREW-LEAVE-0001")
		self.assertEqual(leave["status"], "approved")
		self.assertIn(plan["team"], leave["teams"])
		for key in ("from_date", "to_date", "farms", "teams", "states", "latest_plan_date"):
			self.assertIn(key, out)

	def test_schedule_is_scoped_to_visible_farms(self):
		with mock.patch.object(SCH.crop_scope, "visible_farms", return_value=set()):
			out = SCH.get_schedule(from_date=str(self.day), to_date=str(self.day))
		self.assertEqual(out["plans"], [])
		self.assertEqual(out["farms"], [])
		farm = frappe.db.get_value("Warehouse", self.greenhouse, "custom_farm")
		with mock.patch.object(SCH.crop_scope, "visible_farms", return_value={farm}):
			out = SCH.get_schedule(from_date=str(self.day), to_date=str(self.day), farm="Not-A-Farm")
		self.assertEqual(out["plans"], [])
		with mock.patch.object(SCH.crop_scope, "visible_farms", return_value={farm}):
			out = SCH.get_schedule(from_date=str(self.day), to_date=str(self.day), farm=farm)
		self.assertTrue(any(p["name"] == self.wo for p in out["plans"]))

	def test_schedule_refuses_users_without_a_spray_role(self):
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			SCH.get_schedule()
