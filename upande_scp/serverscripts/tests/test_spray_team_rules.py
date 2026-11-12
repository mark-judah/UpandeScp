"""Spray team rules: empty team, supervisor count, supervisor role check modes. Rolled back.

Plain unittest (FrappeTestCase bootstrap fails on kaitet.local). Run:
    bench --site kaitet.local execute upande_scp.serverscripts.tests.test_spray_team_rules.run
"""

import unittest

import frappe

from upande_scp.serverscripts.spray_plan_creator import team_rules as TR

ROLE = TR.SUPERVISOR_ROLE


def _sup(e):
	return {"employee": e, "role": "Supervisor"}


class TestEvaluatePure(unittest.TestCase):
	"""No database: the lookup is injected."""

	def lookup(self, status):
		return lambda e: {"employee": e, "employee_name": e, "status": status,
			"message": TR.role_message(e, status)}

	def test_empty_team(self):
		for roster in ([], [{"employee": "", "role": "Supervisor"}]):
			v = TR.evaluate(roster, "Warn", self.lookup(TR.OK))
			self.assertEqual(v["errors"], [TR.NO_MEMBERS])

	def test_no_supervisor_blocked(self):
		v = TR.evaluate([{"employee": "A", "role": "Sprayer"}], "Off", self.lookup(TR.OK))
		self.assertEqual(v["errors"], [TR.NO_SUPERVISOR])

	def test_two_ok_three_blocked(self):
		two = TR.evaluate([_sup("A"), _sup("B")], "Block", self.lookup(TR.OK))
		self.assertEqual((two["errors"], two["warnings"]), ([], []))
		three = TR.evaluate([_sup("A"), _sup("B"), _sup("C")], "Off", self.lookup(TR.OK))
		self.assertEqual(len(three["errors"]), 1)
		self.assertIn("at most 2", three["errors"][0])

	def test_missing_role_modes(self):
		roster = [_sup("A"), {"employee": "B", "role": "Sprayer"}]
		warn = TR.evaluate(roster, "Warn", self.lookup(TR.MISSING_ROLE))
		self.assertEqual(warn["errors"], [])
		self.assertIn("does not have the Spray Supervisor role", warn["warnings"][0])
		blank = TR.evaluate(roster, "", self.lookup(TR.MISSING_ROLE))  # blank = Warn
		self.assertEqual((blank["mode"], len(blank["warnings"])), ("Warn", 1))
		block = TR.evaluate(roster, "Block", self.lookup(TR.MISSING_ROLE))
		self.assertEqual((len(block["errors"]), block["warnings"]), (1, []))
		off = TR.evaluate(roster, "Off", self.lookup(TR.MISSING_ROLE))
		self.assertEqual((off["errors"], off["warnings"]), ([], []))

	def test_no_user_message(self):
		v = TR.evaluate([_sup("A")], "Warn", self.lookup(TR.NO_USER))
		self.assertIn("no active user account", v["warnings"][0])


class TestNoTeamPure(unittest.TestCase):
	def test_modes(self):
		self.assertEqual(TR.no_team_verdict("Off"), ([], []))
		self.assertEqual(TR.no_team_verdict("Warn"), ([], [TR.NO_TEAM]))
		self.assertEqual(TR.no_team_verdict("Block"), ([TR.NO_TEAM], []))


class TestAgainstDatabase(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		emps = frappe.db.sql(
			"SELECT name FROM tabEmployee WHERE status='Active' LIMIT 3", as_dict=True)
		if len(emps) < 3:
			self.skipTest("need three employees")
		self.e = [r["name"] for r in emps]
		self.user = "teamrules-test@example.com"
		if not frappe.db.exists("User", self.user):
			frappe.get_doc({"doctype": "User", "email": self.user, "first_name": "TeamRules",
				"send_welcome_email": 0, "enabled": 1}).insert(ignore_permissions=True)

	def tearDown(self):
		frappe.db.rollback()

	def _link(self, emp, with_role):
		frappe.db.set_value("Employee", emp, "user_id", self.user, update_modified=False)
		frappe.db.delete("Has Role", {"parent": self.user, "role": ROLE})
		if with_role:
			frappe.get_doc({"doctype": "Has Role", "parent": self.user, "parenttype": "User",
				"parentfield": "roles", "role": ROLE}).insert(ignore_permissions=True)

	def test_statuses(self):
		a = self.e[0]
		frappe.db.set_value("Employee", a, "user_id", None, update_modified=False)
		self.assertEqual(TR.supervisor_status(a)["status"], TR.NO_USER)
		self._link(a, False)
		self.assertEqual(TR.supervisor_status(a)["status"], TR.MISSING_ROLE)
		self._link(a, True)
		self.assertEqual(TR.supervisor_status(a)["status"], TR.OK)

	def test_endpoint_and_modes(self):
		a = self.e[0]
		self._link(a, False)
		members = [{"employee": a, "role": "Supervisor"}, {"employee": self.e[1], "role": "Sprayer"}]
		frappe.db.set_single_value(TR.SETTINGS, "spray_supervisor_role_check", "Warn")
		r = TR.check_spray_team(members=members)
		self.assertTrue(r["ok"])
		self.assertEqual(r["supervisors"][0]["status"], TR.MISSING_ROLE)
		self.assertEqual(len(r["warnings"]), 1)
		frappe.db.set_single_value(TR.SETTINGS, "spray_supervisor_role_check", "Block")
		self.assertFalse(TR.check_spray_team(members=members)["ok"])
		frappe.db.set_single_value(TR.SETTINGS, "spray_supervisor_role_check", "")
		self.assertEqual(TR.mode(), "Warn")
		self.assertFalse(TR.check_spray_team(members=[])["ok"])

	def test_enforce_on_plan(self):
		wo = frappe.new_doc("Work Order")
		wo.custom_spray_team = None
		frappe.db.set_single_value(TR.SETTINGS, TR.TEAM_FIELD, "Off")
		self.assertEqual(TR.enforce(wo), [])  # no team, Off: allowed
		frappe.db.set_single_value(TR.SETTINGS, TR.TEAM_FIELD, "Warn")
		self.assertEqual(TR.enforce(wo), [TR.NO_TEAM])
		for blocked in ("Block", ""):  # blank reads as Block
			frappe.db.set_single_value(TR.SETTINGS, TR.TEAM_FIELD, blocked)
			with self.assertRaises(frappe.ValidationError):
				TR.enforce(wo)
		wo.custom_spray_team = "x"
		with self.assertRaises(frappe.ValidationError):
			TR.enforce(wo, rows_sent=True)  # team with no members
		a = self.e[0]
		self._link(a, False)
		wo.append("custom_spray_plan_team_members", {"employee": a, "role": "Supervisor"})
		frappe.db.set_single_value(TR.SETTINGS, "spray_supervisor_role_check", "Warn")
		self.assertEqual(len(TR.enforce(wo)), 1)
		frappe.db.set_single_value(TR.SETTINGS, "spray_supervisor_role_check", "Block")
		with self.assertRaises(frappe.ValidationError):
			TR.enforce(wo)


def run():
	suite = unittest.defaultTestLoader.loadTestsFromModule(__import__(__name__, fromlist=["x"]))
	res = unittest.TextTestRunner(verbosity=2).run(suite)
	frappe.db.rollback()
	if not res.wasSuccessful():
		raise SystemExit(1)
