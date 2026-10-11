"""Personnel section access (personnel spec P3). DB test — direct runner, rolled back.

* A spray plan creator sees and edits only the teams of the farms on their
  ``spray_plan_creators`` roster, and is refused another farm's.
* The Scouts endpoint is limited to its roles and to ``visible_farms``.

Company scope is patched (``crop_scope.allowed_farms``) so the tests do not
depend on which Employee the throwaway users would belong to.
"""

import unittest
from unittest.mock import patch

import frappe

from upande_scp.serverscripts.common import crop_scope
from upande_scp.serverscripts.scouts import api as scouts_api
from upande_scp.serverscripts.sprayers import api

CREATOR = "_test_personnel_creator@example.com"
SCOUTING = "_test_personnel_scouting@example.com"
NOBODY = "_test_personnel_nobody@example.com"
MINE, OTHER = "Chepsito", "Kapkolia"


def _user(email, *roles):
	if not frappe.db.exists("User", email):
		frappe.get_doc({
			"doctype": "User", "email": email, "first_name": email.split("@")[0],
			"send_welcome_email": 0, "enabled": 1,
		}).insert(ignore_permissions=True)
	if roles:
		frappe.get_doc("User", email).add_roles(*roles)


def _roster(farm, user, table="Farm Spray Plan Creator", field="spray_plan_creators"):
	frappe.get_doc({
		"doctype": table, "parent": farm, "parenttype": "Farm", "parentfield": field,
		"user": user, "idx": 99,
	}).db_insert()


def _team(name, farm):
	return frappe.get_doc({
		"doctype": "Spray Team", "team_name": name, "enabled": 1, "custom_farm": farm, "team": [],
	}).insert(ignore_permissions=True)


class _Base(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		crop_scope.clear_cache()
		self.scope = patch.object(crop_scope, "allowed_farms", return_value={MINE, OTHER})

	def tearDown(self):
		frappe.set_user("Administrator")
		crop_scope.clear_cache()
		frappe.db.rollback()

	def as_user(self, email):
		frappe.set_user(email)
		crop_scope.clear_cache()


class TestCreatorTeams(_Base):
	def test_creator_sees_and_edits_only_rostered_farm_teams(self):
		_user(CREATOR, "SCP Spray Plan Creator")
		_roster(MINE, CREATOR)
		mine, other = _team("_TEST PSN MINE", MINE), _team("_TEST PSN OTHER", OTHER)
		self.as_user(CREATOR)
		with self.scope:
			sc = api.scope()
			self.assertFalse(sc["manager"])
			self.assertEqual(sc["farms"], {MINE})
			names = {t["name"] for t in api.get_spray_teams()}
			self.assertIn(mine.name, names)
			self.assertNotIn(other.name, names)
			self.assertEqual(api.save_spray_team(mine.name, enabled=0)["enabled"], 0)
			with self.assertRaises(frappe.PermissionError):
				api.save_spray_team(other.name, enabled=0)
			with self.assertRaises(frappe.PermissionError):
				api.save_spray_team(mine.name, farm=OTHER)
			with self.assertRaises(frappe.PermissionError):
				api.search_employees(OTHER, "")
			self.assertEqual(api.get_context()["farms"], [MINE])
			api.get_sprayers()  # the register opens, scoped the same way

	def test_unrostered_creator_sees_no_team(self):
		_user(CREATOR, "SCP Spray Plan Creator")
		_team("_TEST PSN OTHER", OTHER)
		self.as_user(CREATOR)
		with self.scope:
			self.assertEqual(api.get_spray_teams(), [])

	def test_creator_and_supervisor_rosters_union(self):
		_user(CREATOR, "SCP Spray Plan Creator", "SCP Spray Supervisor")
		_roster(MINE, CREATOR)
		_roster(OTHER, CREATOR, "Farm Spray Supervisor", "spray_supervisors")
		self.as_user(CREATOR)
		with self.scope:
			self.assertEqual(api.scope()["farms"], {MINE, OTHER})


class TestScoutsScope(_Base):
	def fake_quality(self, args, force=False):
		self.asked.append(args)
		return {"scouts": [], "flags": [], "range": {"from_date": args["from_date"], "to_date": args["to_date"]},
		        "clamped": False}

	def setUp(self):
		super().setUp()
		self.asked = []
		self.q = patch.object(scouts_api._quality, "quality", side_effect=self.fake_quality)
		self.map = patch.object(scouts_api.scouting_metrics, "get_farms_and_warehouses",
		                        return_value={MINE: ["GH-A"], OTHER: ["GH-B"]})

	def test_scouting_user_is_held_to_visible_farms(self):
		_user(SCOUTING, "SCP Scouting User")
		self.as_user(SCOUTING)
		with self.q, self.map, patch.object(crop_scope, "allowed_farms", return_value={MINE}):
			out = scouts_api.get_scouts(crop="Rose")
			self.assertEqual((out["farm"], out["farms"], out["allFarms"]), (MINE, [MINE], False))
			self.assertEqual(self.asked[-1]["farm"], MINE)
			with self.assertRaises(frappe.PermissionError):
				scouts_api.get_scouts(crop="Rose", farm=OTHER)
			scouts_api.get_scouts(crop="Rose", farm=MINE, from_date="2031-01-05", to_date="2031-02-01")
			self.assertEqual(self.asked[-1]["from_date"], "2031-01-05")

	def test_all_farms_when_every_crop_farm_is_visible(self):
		with self.q, self.map:
			out = scouts_api.get_scouts(crop="Rose")
		self.assertEqual((out["farm"], out["allFarms"]), ("", True))
		self.assertEqual(out["farms"], [MINE, OTHER])

	def test_other_roles_are_refused(self):
		_user(NOBODY, "SCP Spray Supervisor")
		self.as_user(NOBODY)
		with self.q, self.map, self.assertRaises(frappe.PermissionError):
			scouts_api.get_scouts(crop="Rose")
		self.assertEqual(self.asked, [])

	def test_default_range_is_the_last_four_complete_weeks(self):
		self.assertEqual(scouts_api.default_range("2026-10-11"), ("2026-09-07", "2026-10-04"))  # a Sunday
		self.assertEqual(scouts_api.default_range("2026-10-12"), ("2026-09-14", "2026-10-11"))  # a Monday
