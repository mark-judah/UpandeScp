import unittest

import frappe

from upande_scp.serverscripts.spray_plan_creator import admin

ROLE = "SCP Spray Supervisor"


class TestFarmSupervisorRoster(unittest.TestCase):
	"""Plain TestCase; every write is rolled back."""

	def setUp(self):
		frappe.flags.in_test = True
		frappe.set_user("Administrator")

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback()

	def _user(self, email, enabled=1, role=ROLE):
		u = frappe.get_doc({
			"doctype": "User", "email": email, "first_name": email.split("@")[0],
			"enabled": enabled, "send_welcome_email": 0,
		})
		if role:
			u.append("roles", {"role": role})
		u.insert(ignore_permissions=True)
		return u.name

	def _farm(self):
		return frappe.get_all("Farm", pluck="name", limit=1)[0]

	def test_set_and_list_with_full_names(self):
		farm = self._farm()
		u = self._user("sup.roster1@example.com")
		out = admin.set_farm_supervisors(farm, [u])
		self.assertEqual([r["user"] for r in out["supervisors"]], [u])
		rows = {r["farm"]: r for r in admin.list_farms_with_creators()}
		self.assertEqual([r["user"] for r in rows[farm]["supervisors"]], [u])
		self.assertTrue(rows[farm]["supervisors"][0]["full_name"])
		# Setting [] clears it.
		self.assertEqual(admin.set_farm_supervisors(farm, [])["supervisors"], [])

	def test_user_without_role_is_named(self):
		farm = self._farm()
		u = self._user("sup.norole@example.com", role=None)
		with self.assertRaises(frappe.ValidationError) as cm:
			admin.set_farm_supervisors(farm, [u])
		self.assertIn(u, str(cm.exception))
		self.assertIn(ROLE, str(cm.exception))

	def test_disabled_user_refused(self):
		farm = self._farm()
		u = self._user("sup.disabled@example.com", enabled=0)
		with self.assertRaises(frappe.ValidationError) as cm:
			admin.set_farm_supervisors(farm, [u])
		self.assertIn(u, str(cm.exception))

	def test_candidates_only_role_holders(self):
		yes = self._user("sup.cand.yes@example.com")
		no = self._user("sup.cand.no@example.com", role=None)
		got = {c["user"] for c in admin.list_spray_supervisor_candidates("sup.cand")}
		self.assertIn(yes, got)
		self.assertNotIn(no, got)

	def test_non_admin_refused(self):
		frappe.set_user("Guest")
		with self.assertRaises(frappe.ValidationError):
			admin.set_farm_supervisors(self._farm(), [])
		with self.assertRaises(frappe.ValidationError):
			admin.list_spray_supervisor_candidates("x")
