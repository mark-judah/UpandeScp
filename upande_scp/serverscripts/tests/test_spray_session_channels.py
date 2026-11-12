"""Spray sessions that cross between online and offline.

The user-reported failures this guards:

* an end journalled offline after a mix (and start) confirmed online never reached the
  office: the token carried no `mix_at` worth sending, so the sync held it as
  "incomplete", and with no scans in it the preflight refused it as a different plan;
* a session that began offline was applied in parts the moment signal flickered, so the
  plan moved under a supervisor still spraying with no signal;
* a token that replayed the start and left the end to the online endpoint stayed
  "Partial" for ever under a Completed plan.

Run: cd sites && ../env/bin/python <runner> \
        upande_scp.serverscripts.tests.test_spray_session_channels
"""
import unittest
from unittest import mock

import frappe

from upande_scp.serverscripts.spray_plan_creator import offline_session as OS


class TestStepsTheServerAlreadyHas(unittest.TestCase):
	def test_an_end_alone_is_held_when_the_plan_never_started(self):
		out = OS.assess_session({"ended_at": "2026-11-11 09:00:00"}, "Tank Mix Manufactured")
		self.assertEqual(out["hold"][0], OS.STATUS_INCOMPLETE)

	def test_an_end_alone_applies_once_the_plan_is_spraying(self):
		out = OS.assess_session({"ended_at": "2026-11-11 09:00:00"}, "Spraying In Progress")
		self.assertIsNone(out["hold"])
		self.assertEqual(out["steps"], ["mix", "start", "end"])

	def test_a_start_alone_applies_once_the_mix_is_on_the_server(self):
		out = OS.assess_session({"started_at": "2026-11-11 09:00:00"}, "Tank Mix Manufactured")
		self.assertIsNone(out["hold"])
		self.assertEqual(out["steps"], ["mix", "start"])

	def test_without_a_state_the_old_rules_stand(self):
		self.assertEqual(
			OS.assess_session({"started_at": "2026-11-11 09:00:00"})["hold"][0],
			OS.STATUS_INCOMPLETE,
		)

	def test_ordering_is_still_checked_where_both_moments_exist(self):
		out = OS.assess_session(
			{"mix_at": "2026-11-11 09:00:00", "started_at": "2026-11-11 08:00:00"},
			"Tank Mix Manufactured",
		)
		self.assertEqual(out["hold"][0], OS.STATUS_INCOMPLETE)


class TestOfflineChannelTravelsWhole(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")

	def test_an_unfinished_offline_session_is_not_applied(self):
		with mock.patch.object(OS, "_assert_replay_allowed") as allowed, \
		     mock.patch.object(OS, "_upsert_token") as upsert:
			out = OS.sync_spray_session({
				"token": "spray-test-offline-unfinished", "work_order": "MFG-WO-NOPE",
				"channel": "offline", "mix_at": "2026-11-11T06:00:00Z",
				"started_at": "2026-11-11T06:05:00Z",
			})
		self.assertEqual(out["status"], "Pending")
		allowed.assert_not_called()
		upsert.assert_not_called()
		self.assertFalse(frappe.db.exists(OS.TOKEN, "spray-test-offline-unfinished"))


class TestPreflightPastTheMix(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")
		cls.wo = frappe.db.get_value(
			"Work Order",
			{"custom_type": OS.AFP_TYPE, "workflow_state": "Spraying In Progress"},
			"name",
		)

	def test_a_later_step_without_scans_is_not_a_different_plan(self):
		if not self.wo:
			self.skipTest("no plan in Spraying In Progress on this site")
		out = OS.preflight({"work_order": self.wo, "ended_at": "2026-11-11T06:00:00Z", "scans": []})
		self.assertFalse([p for p in out["problems"] if p.startswith("not scanned")], out)


if __name__ == "__main__":
	unittest.main()
