"""A spray session that reaches the server after its plan day's cut-off is refused, unless a
manager allowed that token. Plain TestCase (see test_spray_rates); every write rolls back."""
import unittest
from datetime import datetime, timedelta
from unittest import mock

import frappe

from upande_scp.serverscripts.spray_plan_creator import lateness, offline_session as OS


class TestSessionCutoff(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.flags.in_test = True
		frappe.flags.enforce_session_cutoff = True
		cls.wo = frappe.db.get_value(
			"Work Order", {"custom_type": OS.AFP_TYPE}, "name", order_by="creation asc"
		)

	@classmethod
	def tearDownClass(cls):
		frappe.flags.enforce_session_cutoff = False

	def setUp(self):
		if not self.wo:
			self.skipTest("no Application Floor Plan on this site")
		self.day = datetime(2031, 6, 10)
		frappe.db.set_value("Work Order", self.wo, {
			"planned_start_date": self.day.replace(hour=6),
			"custom_scheduled_application_time": self.day.replace(hour=6),
		})
		self.deadline, self.hhmm, _ = lateness.session_cutoff(self.wo)

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback()

	def _token(self, name, **kw):
		d = frappe.get_doc({"doctype": "Spray Session Token", "token": name,
			"work_order": self.wo, "status": "Pending", **kw})
		d.insert(ignore_permissions=True, ignore_links=True)
		return d

	def test_refused_after_cutoff_with_clear_message(self):
		late = self.deadline + timedelta(minutes=5)
		with self.assertRaises(frappe.ValidationError) as cm:
			lateness.assert_session_in_time(self.wo, "T-LATE", now=late)
		self.assertIn(f"after the {self.hhmm} cut-off for 2031-06-10", str(cm.exception))
		self.assertIn("Ask a manager to allow it", str(cm.exception))

	def test_accepted_before_cutoff(self):
		lateness.assert_session_in_time(self.wo, "T-OK", now=self.deadline - timedelta(minutes=1))

	def test_sync_refuses_after_cutoff_but_synced_token_is_idempotent(self):
		payload = {"token": "T-SYNC", "work_order": self.wo, "mix_at": str(self.day.replace(hour=7)),
			"ended_at": str(self.day.replace(hour=8)), "started_at": str(self.day.replace(hour=7, minute=30))}
		with mock.patch.object(lateness, "now_datetime", return_value=self.deadline + timedelta(hours=1)):
			with self.assertRaises(frappe.ValidationError) as cm:
				OS.sync_spray_session(payload)
			self.assertIn("cut-off", str(cm.exception))
			# an already-Synced token returns as before, cut-off or not
			self._token("T-DONE", status="Synced")
			self.assertTrue(OS.sync_spray_session({**payload, "token": "T-DONE"})["already_synced"])

	def test_accepted_when_allowed(self):
		self._token("T-ALLOWED", allow_after_cutoff=1)
		lateness.assert_session_in_time(self.wo, "T-ALLOWED", now=self.deadline + timedelta(hours=3))
		# another token of the same plan is still refused
		with self.assertRaises(frappe.ValidationError):
			lateness.assert_session_in_time(self.wo, "T-OTHER", now=self.deadline + timedelta(hours=3))

	def test_postponed_plan_uses_new_date(self):
		new_day = self.day + timedelta(days=2)
		frappe.get_doc({
			"doctype": "Spray Plan Postponement", "work_order": self.wo, "status": "Approved",
			"from_datetime": self.day.replace(hour=6), "to_datetime": new_day.replace(hour=6),
			"reason": "test",
		}).insert(ignore_permissions=True, ignore_links=True)
		self.assertEqual(str(lateness.session_cutoff(self.wo)[2]), "2031-06-12")
		# the next day is within the new date's cut-off, so it is accepted
		lateness.assert_session_in_time(self.wo, "T-P", now=self.day.replace(day=11, hour=23))
		with self.assertRaises(frappe.ValidationError) as cm:
			lateness.assert_session_in_time(self.wo, "T-P", now=new_day.replace(hour=23, minute=59))
		self.assertIn("2031-06-12", str(cm.exception))

	def test_allow_endpoint_is_gm_only_and_creates_the_row(self):
		user = frappe.db.get_value("User", {"enabled": 1, "name": ("not in", ["Administrator", "Guest"])})
		frappe.set_user(user)
		roles = set(frappe.get_roles(user))
		if roles & {"SCP General Manager", "System Manager"}:
			self.skipTest("first user is already a manager")
		with self.assertRaises(frappe.PermissionError):
			OS.allow_after_cutoff(["T-NEW"])
		frappe.set_user("Administrator")
		with self.assertRaises(frappe.ValidationError):  # unseen token needs its plan
			OS.allow_after_cutoff(["T-NEW"])
		self.assertEqual(OS.allow_after_cutoff([{"token": "T-NEW", "work_order": self.wo}])["allowed"], ["T-NEW"])
		self.assertEqual(frappe.db.get_value("Spray Session Token", "T-NEW", "allow_after_cutoff"), 1)
		self._token("T-EXIST")
		OS.allow_after_cutoff(["T-EXIST"])
		self.assertEqual(frappe.db.get_value("Spray Session Token", "T-EXIST", "allow_after_cutoff"), 1)
