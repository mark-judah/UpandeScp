import unittest
from datetime import timedelta
from unittest import mock

import frappe
from frappe.utils import now_datetime, today

from upande_scp.serverscripts.spray_plan_creator import spray_session as SS
from upande_scp.serverscripts.spray_plan_creator import spray_supervision as SV


class TestSupervisionRules(unittest.TestCase):
	"""Pure rules: no database."""

	def test_mode_blank_is_off(self):
		self.assertEqual(SV.normalise_mode(""), "Off")
		self.assertEqual(SV.normalise_mode(None), "Off")
		self.assertEqual(SV.normalise_mode("junk"), "Off")
		self.assertEqual(SV.normalise_mode("block"), "Block")
		self.assertEqual(SV.normalise_mode("Warn"), "Warn")

	def test_absent_members(self):
		team = [{"employee": "A"}, {"employee": "B"}, {"employee": "C"}]
		self.assertEqual([m["employee"] for m in SV.absent_members(team, {"A": "06:01"})], ["B", "C"])
		self.assertEqual(SV.absent_members(team, {"A": 1, "B": 1, "C": 1}), [])

	def test_notice_tone_and_block_suffix(self):
		one = SV.absent_notice(["Jane Doe"])
		self.assertIn("Jane Doe has no check-in recorded today in Time & Attendance", one)
		self.assertIn("remove them from the team before starting", one)
		self.assertEqual(SV.absent_notice([]), "")
		self.assertIn("A, B and C have no check-in", SV.absent_notice(["A", "B", "C"]))
		self.assertIn("cannot start", SV.block_message(["Jane Doe"]))

	def test_can_run(self):
		self.assertTrue(SV.can_run("a@x", ["a@x", "b@x"]))
		self.assertFalse(SV.can_run("c@x", ["a@x", "b@x"]))
		self.assertTrue(SV.can_run("c@x", [], override=True))
		self.assertFalse(SV.can_run(None, ["a@x"], override=True))


class TestSupervisionDb(unittest.TestCase):
	"""Plain TestCase (FrappeTestCase bootstrap fails on kaitet.local). Writes are rolled back."""

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback()

	def _plan(self):
		rows = frappe.db.sql(
			"""SELECT c.parent, c.employee FROM `tabCustom Spray Plan Team Member` c
			   JOIN `tabEmployee` e ON e.name = c.employee
			   WHERE c.parenttype = 'Work Order' AND LOWER(TRIM(c.role)) = 'supervisor'
			     AND IFNULL(e.user_id, '') != '' LIMIT 1""", as_dict=True)
		if not rows:
			self.skipTest("no plan with a supervisor that has a user")
		return rows[0]

	def _punch(self, employee, when, log_type="IN"):
		name = f"TST-CHK-{employee}-{log_type}-{abs(hash(str(when))) % 10**6}"
		frappe.db.sql(
			"""INSERT INTO `tabEmployee Checkin` (name, creation, modified, owner, modified_by,
			   employee, log_type, `time`) VALUES (%s, NOW(), NOW(), 'Administrator',
			   'Administrator', %s, %s, %s)""", (name, employee, log_type, when))

	def test_checkin_times_earliest_in_today_only(self):
		emp = self._plan().employee
		now = now_datetime()
		start = now.replace(hour=0, minute=30, second=0, microsecond=0)
		self._punch(emp, start + timedelta(hours=6))
		self._punch(emp, start + timedelta(hours=7, minutes=5))
		self._punch(emp, start + timedelta(hours=9), "OUT")
		got = SV.checkin_times([emp], today())
		self.assertIn(emp, got)
		self.assertTrue(got[emp].startswith(str(start + timedelta(hours=6))[:16]))
		# a different day does not see today's punches
		self.assertNotIn(emp, SV.checkin_times([emp], (now - timedelta(days=400)).date()))

	def test_only_out_punch_is_not_a_checkin(self):
		emp = self._plan().employee
		self._punch(emp, now_datetime().replace(hour=1, minute=0, second=0, microsecond=0), "OUT")
		self.assertNotIn(emp, SV.checkin_times([emp], today()))

	def test_feed_fields_and_can_run(self):
		plan = self._plan()
		sup_user = frappe.db.get_value("Employee", plan.employee, "user_id")
		wo = {"name": plan.parent, "custom_greenhouse": None, "custom_spray_team": None}
		SV.attach_to_plans([wo], today(), user=sup_user)
		self.assertIn(plan.employee, [s["employee"] for s in wo["spray_supervisors"]])
		self.assertLessEqual(len(wo["spray_supervisors"]), 2)
		self.assertTrue(wo["can_run"])
		self.assertEqual(wo["can_run_user"], sup_user)
		self.assertEqual(wo["checkin_day"], today())
		self.assertTrue(wo["team_roster"])
		self.assertIn("checked_in", wo["team_roster"][0])
		other = {"name": plan.parent, "custom_greenhouse": None, "custom_spray_team": None}
		SV.attach_to_plans([other], today(), user="Guest")
		self.assertFalse(other["can_run"])

	def test_assert_can_operate_supervisors_only(self):
		plan = self._plan()
		sup_user = frappe.db.get_value("Employee", plan.employee, "user_id")
		frappe.set_user(sup_user)
		SS.assert_can_operate(plan.parent, "scan")
		SS.assert_can_operate(plan.parent, "start")
		frappe.set_user("Guest")
		for action in ("scan", "start", "end"):
			with self.assertRaises(frappe.PermissionError):
				SS.assert_can_operate(plan.parent, action)

	def test_replay_still_authorised(self):
		plan = self._plan()
		frappe.set_user("Guest")
		frappe.flags.scp_replay_work_order = plan.parent
		try:
			SS.assert_can_operate(plan.parent, "start")
		finally:
			frappe.flags.scp_replay_work_order = None

	def test_block_refuses_live_start_but_not_replay(self):
		plan = self._plan()
		wo = frappe.get_doc("Work Order", plan.parent)
		with mock.patch.object(SV, "checkin_mode", return_value="Block"), \
		     mock.patch.object(SV, "checkin_times", return_value={}):
			with self.assertRaises(frappe.ValidationError):
				SV.assert_start_allowed(wo, today(), can_block=True)
			notes = SV.assert_start_allowed(wo, today(), can_block=False)
			self.assertEqual(len(notes), 1)
		with mock.patch.object(SV, "checkin_mode", return_value="Warn"), \
		     mock.patch.object(SV, "checkin_times", return_value={}):
			self.assertEqual(len(SV.assert_start_allowed(wo, today(), can_block=True)), 1)
		with mock.patch.object(SV, "checkin_mode", return_value="Off"):
			self.assertEqual(SV.assert_start_allowed(wo, today()), [])
		everyone = {r.employee: "06:00" for r in wo.custom_spray_plan_team_members}
		with mock.patch.object(SV, "checkin_mode", return_value="Block"), \
		     mock.patch.object(SV, "checkin_times", return_value=everyone):
			self.assertEqual(SV.assert_start_allowed(wo, today()), [])
