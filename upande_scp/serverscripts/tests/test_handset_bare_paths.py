"""The bare-path endpoints the handset calls, and that the hooks alias must keep alive.

These paths (`/api/method/fetchScheduledApplications` and friends) were API-type Server
Scripts until `57e09ce` dropped them as dead. They were not dead — their callers live in
the Upande-Scout repo, which that audit did not look at. The regression is invisible from
inside this repo, which is exactly why it needs a test here.

The first test is the important one: it walks Frappe's own dispatch path for every bare
name the app posts to, so a future deletion fails a test rather than a farm.
"""

import unittest

import frappe

#: Every short path `upande_scout_rn/src/services/api.ts` posts to. Keep in step with it.
#: A name here with no resolution is a handset in the field getting a 404.
HANDSET_BARE_PATHS = (
	"fetchScheduledApplications",
	"fetchGreenhouseBeds",
	"start_work_order",
	"update_work_order_dates",
	"update_work_order_team",
)


def _resolves(cmd: str) -> bool:
	"""True when `/api/method/<cmd>` would reach something, by Frappe's own rules."""
	from frappe.core.doctype.server_script.server_script_utils import (
		get_server_script_map,
	)
	from frappe.handler import get_attr

	resolved = frappe.override_whitelisted_method(cmd)
	if get_server_script_map().get("_api", {}).get(resolved):
		return True
	try:
		get_attr(resolved)
		return True
	except Exception:
		return False


class TestHandsetBarePathsResolve(unittest.TestCase):
	def test_every_bare_path_the_app_calls_resolves(self):
		unreachable = [name for name in HANDSET_BARE_PATHS if not _resolves(name)]
		self.assertEqual(
			unreachable,
			[],
			f"these bare paths 404 for every handset in the field: {unreachable}",
		)

	def test_each_alias_points_at_a_whitelisted_function(self):
		# An alias onto a function without `@frappe.whitelist()` is a 403 rather than a
		# 404 — the same outage with a different error code. `frappe.whitelisted` is the
		# registry the decorator writes to and `frappe.is_whitelisted` reads.
		from frappe.handler import get_attr

		for name in HANDSET_BARE_PATHS:
			with self.subTest(path=name):
				fn = get_attr(frappe.override_whitelisted_method(name))
				self.assertIn(
					fn,
					frappe.whitelisted,
					f"{name} resolves but is not whitelisted",
				)


class TestFetchScheduledApplications(unittest.TestCase):
	def test_returns_only_submitted_floor_plans(self):
		from upande_scp.serverscripts.mobile.scheduled_applications import (
			fetchScheduledApplications,
		)

		plans = fetchScheduledApplications()
		self.assertIsInstance(plans, list)
		for plan in plans[:50]:
			self.assertEqual(plan["custom_type"], "Application Floor Plan")

	def test_every_plan_carries_its_required_items(self):
		from upande_scp.serverscripts.mobile.scheduled_applications import (
			fetchScheduledApplications,
		)

		plans = fetchScheduledApplications()
		if not plans:
			self.skipTest("no submitted floor plans on this site")
		for plan in plans[:20]:
			self.assertIn("required_items", plan)
			self.assertIsInstance(plan["required_items"], list)

	def test_a_start_date_narrows_the_list(self):
		from upande_scp.serverscripts.mobile.scheduled_applications import (
			fetchScheduledApplications,
		)

		everything = fetchScheduledApplications()
		if not everything:
			self.skipTest("no submitted floor plans on this site")
		# Far future: nothing can be scheduled after it, so the filter must bite.
		self.assertEqual(fetchScheduledApplications("2099-01-01"), [])


class TestFetchGreenhouseBeds(unittest.TestCase):
	def test_an_unknown_station_is_empty_not_an_error(self):
		from upande_scp.serverscripts.mobile.greenhouse_beds import fetchGreenhouseBeds

		self.assertEqual(fetchGreenhouseBeds("No Such Greenhouse - ZZ"), [])

	def test_a_missing_argument_does_not_throw(self):
		from upande_scp.serverscripts.mobile.greenhouse_beds import fetchGreenhouseBeds

		# The scout is mid-configure; a bad argument must cost an empty list, not a crash.
		self.assertEqual(fetchGreenhouseBeds(None), [])

	def test_every_unit_is_named(self):
		from upande_scp.serverscripts.mobile.greenhouse_beds import fetchGreenhouseBeds

		station = frappe.db.get_value("Bed", {"greenhouse": ("is", "set")}, "greenhouse")
		if not station:
			self.skipTest("no beds on this site")
		beds = fetchGreenhouseBeds(station)
		self.assertTrue(beds)
		for bed in beds:
			self.assertIn(bed["unit_type"], ("Bed", "Row", "Band"))

	def test_more_than_a_page_of_beds_comes_back(self):
		# The deleted Server Script used `frappe.db.get_list`, whose default
		# `limit_page_length` is 20 — so a 60-bed greenhouse silently returned 20 and the
		# scout could not reach the rest. This is the bug the restore fixes.
		from upande_scp.serverscripts.mobile.greenhouse_beds import fetchGreenhouseBeds

		row = frappe.db.sql(
			"""SELECT greenhouse, COUNT(*) n FROM `tabBed`
			   WHERE greenhouse IS NOT NULL AND greenhouse != ''
			   GROUP BY greenhouse HAVING n > 20 ORDER BY n DESC LIMIT 1""",
			as_dict=True,
		)
		if not row:
			self.skipTest("no station on this site has more than 20 units")
		beds = fetchGreenhouseBeds(row[0].greenhouse)
		self.assertEqual(len(beds), row[0].n)


class TestUpdateWorkOrderTeam(unittest.TestCase):
	def test_an_empty_team_is_refused(self):
		from upande_scp.serverscripts.spray_plan_creator.spray_session import (
			update_work_order_team,
		)

		wo = frappe.db.get_value("Work Order", {"custom_type": "Application Floor Plan"}, "name")
		if not wo:
			self.skipTest("no floor plans on this site")
		# Overwriting a real team with nothing would cost the logsheet its applicators.
		with self.assertRaises(frappe.ValidationError):
			update_work_order_team(wo, [])

	def test_an_unknown_plan_is_refused(self):
		from upande_scp.serverscripts.spray_plan_creator.spray_session import (
			update_work_order_team,
		)

		with self.assertRaises(frappe.ValidationError):
			update_work_order_team("MFG-WO-NOPE-0000", [{"id": "HR-EMP-00001"}])

	def test_members_without_an_employee_are_dropped(self):
		from upande_scp.serverscripts.spray_plan_creator.spray_session import (
			update_work_order_team,
		)

		wo = frappe.db.get_value("Work Order", {"custom_type": "Application Floor Plan"}, "name")
		if not wo:
			self.skipTest("no floor plans on this site")
		with self.assertRaises(frappe.ValidationError):
			update_work_order_team(wo, [{"name": "Someone With No Employee Link"}])
