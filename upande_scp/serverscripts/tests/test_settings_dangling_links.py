"""A dead link in one child row must not take the settings page down with it.

Frappe re-validates every child row of a Single on save, including the rows
nobody touched. A test that created an Item Group, wired it into Spray Plan
Settings and then rolled back left two rows pointing at a record that no longer
exists — and from then on EVERY save of that Single died with

    LinkValidationError: Could not find Row #3: Item Group: _TEST CP Chemicals

which is the whole settings page, every tab, not just the one being edited. The
farm loses the page and nothing on screen says why.

A link that has gone is data that has gone. Dropping the row is the only
outcome that leaves the page usable, and it is what a person would do by hand.
"""

import unittest

import frappe

from upande_scp.serverscripts.spray_plan_creator import settings as settings_api

GHOST = "_TEST GHOST ITEM GROUP THAT DOES NOT EXIST"
SETTINGS = "Spray Plan Settings"


class TestADeadLinkDoesNotBlockTheSettingsPage(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")

	def setUp(self):
		self.assertFalse(
			frappe.db.exists("Item Group", GHOST),
			"this test needs a name no Item Group actually has",
		)
		doc = frappe.get_single(SETTINGS)
		self.before = [r.item_group for r in (doc.get("foliar_item_groups") or [])]

	def tearDown(self):
		# Leave the farm's own rows exactly as they were.
		doc = frappe.get_single(SETTINGS)
		doc.set("foliar_item_groups", [])
		for group in self.before:
			doc.append("foliar_item_groups", {"item_group": group})
		doc.save(ignore_permissions=True)
		frappe.db.commit()

	def _add_ghost_row(self):
		"""Write the bad row the way the real one arrived: straight into the
		table, with no validation between it and the database."""
		doc = frappe.get_single(SETTINGS)
		row = doc.append("foliar_item_groups", {"item_group": GHOST})
		doc.flags.ignore_links = True
		doc.save(ignore_permissions=True)
		frappe.db.commit()
		return row

	def test_the_save_succeeds_and_the_dead_row_is_gone(self):
		self._add_ghost_row()

		bundle = settings_api.get_settings_bundle()["spray_plan"]
		result = settings_api.save_spray_plan_settings(bundle)
		self.assertTrue(result.get("ok"))

		doc = frappe.get_single(SETTINGS)
		groups = [r.item_group for r in (doc.get("foliar_item_groups") or [])]
		self.assertNotIn(GHOST, groups, "the dead link survived the save")

	def test_the_rows_that_still_point_somewhere_survive(self):
		"""Dropping the dead one must not take the live ones with it."""
		self._add_ghost_row()
		settings_api.save_spray_plan_settings(
			settings_api.get_settings_bundle()["spray_plan"]
		)

		doc = frappe.get_single(SETTINGS)
		groups = [r.item_group for r in (doc.get("foliar_item_groups") or [])]
		for group in self.before:
			self.assertIn(group, groups, f"{group} was dropped and should not have been")

	def test_it_says_what_it_dropped(self):
		"""Silently discarding a farm's configuration is how the next hour is
		spent. The answer names every row it let go."""
		self._add_ghost_row()
		result = settings_api.save_spray_plan_settings(
			settings_api.get_settings_bundle()["spray_plan"]
		)
		dropped = result.get("dropped") or []
		self.assertTrue(
			any(GHOST in str(d) for d in dropped),
			f"nothing in {dropped!r} names the row that was removed",
		)

	def test_a_clean_save_drops_nothing(self):
		result = settings_api.save_spray_plan_settings(
			settings_api.get_settings_bundle()["spray_plan"]
		)
		self.assertEqual(result.get("dropped") or [], [])
