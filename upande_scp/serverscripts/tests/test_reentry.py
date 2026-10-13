"""Re-entry and pre-harvest: clocks from the real spray end, PHI across the mix,
the once-only notices, the scheduler clearing them, and status classification.

The DB tests borrow one Completed Work Order, stub the product lookups (so no
Spray Product is edited), and put every field they touch back.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_reentry
"""

import unittest
from datetime import datetime, timedelta
from unittest import mock

import frappe

from upande_scp.serverscripts.common import crop_protection as CP
from upande_scp.serverscripts.spray_plan_creator import reentry as R

U1 = "_test_scp_reentry_1@example.com"
U2 = "_test_scp_reentry_2@example.com"
T0 = datetime(2026, 10, 13, 9, 40)

TOUCHED = [
	"actual_end_date", "custom_reentry_period_hrs", "custom_reentry_time", "custom_phi_days",
	"custom_harvest_after", "custom_reentry_notified", "custom_reentry_cleared_notified",
	"custom_phi_cleared_notified",
]


class TestPure(unittest.TestCase):
	def test_reentry_time_counts_from_the_actual_end(self):
		self.assertEqual(CP.reentry_time(T0, 12), T0 + timedelta(hours=12))
		self.assertEqual(CP.reentry_time(T0, 0), T0)

	def test_harvest_after_is_end_plus_phi_days_and_empty_for_zero(self):
		self.assertEqual(CP.harvest_after(T0, 3), T0 + timedelta(days=3))
		self.assertIsNone(CP.harvest_after(T0, 0))
		self.assertIsNone(CP.harvest_after(None, 3))

	def test_phi_is_the_max_across_the_mix(self):
		days = {"A": 3.0, "B": 14.0, "C": 0.0}
		with mock.patch.object(CP, "get_phi_days", side_effect=lambda c: days[c]):
			self.assertEqual(CP.max_phi_days(["A", "B", "C"]), 14.0)
			self.assertEqual(CP.max_phi_days(["C"]), 0.0)
			self.assertEqual(CP.max_phi_days([]), 0.0)

	def test_classify(self):
		re_t, ha = T0 + timedelta(hours=12), T0 + timedelta(days=3)
		self.assertEqual(R.classify(re_t, ha, T0 + timedelta(hours=1)), R.NO_ENTRY)
		self.assertEqual(R.classify(re_t, ha, T0 + timedelta(hours=13)), R.HARVEST_HELD)
		self.assertEqual(R.classify(re_t, ha, T0 + timedelta(days=4)), R.CLEAR)
		self.assertEqual(R.classify(re_t, None, T0 + timedelta(hours=13)), R.CLEAR)
		self.assertEqual(R.classify(None, None, T0), R.CLEAR)

	def test_message_with_and_without_restrictions(self):
		m = R.sprayed_message("GH 18", ["Mancozeb"], T0, T0 + timedelta(hours=12), T0 + timedelta(days=3), 12)
		self.assertIn("GH 18 sprayed (Mancozeb)", m)
		self.assertIn("ended 09:40", m)
		self.assertIn("No entry until 21:40", m)
		self.assertIn("Harvest from Fri 16 Oct", m)
		m = R.sprayed_message("GH 18", ["Foliar"], T0, T0, None, 0)
		self.assertIn("No re-entry restriction", m)
		self.assertNotIn("Harvest", m)

	def test_effective_times_ignore_the_stale_scheduled_clock(self):
		re_t, ha = R.effective_times(T0, 6)
		self.assertEqual(re_t, T0 + timedelta(hours=6))
		self.assertIsNone(ha)

	def test_house_label_drops_the_company_suffix(self):
		self.assertEqual(R.house_label("Chepsito GH 18 - KR"), "Chepsito GH 18")
		self.assertEqual(R.house_label(None), "")


def _ensure_user(email):
	if not frappe.db.exists("User", email):
		frappe.get_doc({
			"doctype": "User", "email": email, "first_name": email.split("@")[0],
			"send_welcome_email": 0, "enabled": 1,
		}).insert(ignore_permissions=True)


def _wipe(*emails):
	for e in emails:
		for n in frappe.get_all("Notification Log", filters={"for_user": e}, pluck="name"):
			frappe.delete_doc("Notification Log", n, force=True, ignore_permissions=True)


class TestOnAWorkOrder(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")
		_ensure_user(U1)
		_ensure_user(U2)
		row = frappe.db.sql(
			"""SELECT wo.name FROM `tabWork Order` wo
			   JOIN `tabWork Order Item` i ON i.parent = wo.name
			   WHERE wo.workflow_state = 'Completed' AND IFNULL(wo.custom_greenhouse, '') != ''
			   LIMIT 1"""
		)
		if not row:
			raise unittest.SkipTest("no Completed Work Order with items on this site")
		cls.wo = row[0][0]
		cls.snapshot = frappe.db.get_value("Work Order", cls.wo, TOUCHED, as_dict=True)
		frappe.db.commit()

	def setUp(self):
		_wipe(U1, U2)
		frappe.db.set_value("Work Order", self.wo, {
			"actual_end_date": None, "custom_reentry_notified": 0,
			"custom_reentry_cleared_notified": 0, "custom_phi_cleared_notified": 0,
			"custom_harvest_after": None, "custom_reentry_time": None,
		}, update_modified=False)
		self._patches = [
			mock.patch.object(R, "_production_supervisors", return_value=[U1]),
			mock.patch.object(CP, "max_reentry_interval_hrs", return_value=12.0),
			mock.patch.object(CP, "max_phi_days", return_value=3.0),
		]
		for p in self._patches:
			p.start()
		self.mail = mock.patch("frappe.sendmail").start()

	def tearDown(self):
		mock.patch.stopall()
		frappe.db.set_value("Work Order", self.wo, dict(self.snapshot), update_modified=False)
		_wipe(U1, U2)
		frappe.db.commit()

	def _wo(self):
		return frappe.get_doc("Work Order", self.wo)

	def _bell(self):
		return frappe.get_all(
			"Notification Log", filters={"for_user": U1, "scp_category": "reentry"},
			fields=["subject", "link"], order_by="creation",
		)

	def test_spray_end_stamps_the_clocks_from_the_actual_end(self):
		out = R.apply_spray_end(self._wo(), T0)
		v = frappe.db.get_value("Work Order", self.wo, TOUCHED, as_dict=True)
		self.assertEqual(v.custom_reentry_time, T0 + timedelta(hours=12))
		self.assertEqual(v.custom_phi_days, 3)
		self.assertEqual(v.custom_harvest_after, T0 + timedelta(days=3))
		self.assertEqual(v.custom_reentry_notified, 1)
		self.assertEqual(v.custom_reentry_cleared_notified, 0)
		self.assertEqual(v.custom_phi_cleared_notified, 0)
		self.assertIn(U1, out["notified"])

	def test_notice_goes_out_once_by_bell_and_email_and_links_the_page(self):
		R.apply_spray_end(self._wo(), T0)
		rows = self._bell()
		self.assertEqual(len(rows), 1)
		self.assertIn("ended 09:40", rows[0].subject)
		self.assertIn("No entry until 21:40", rows[0].subject)
		self.assertIn("Harvest from", rows[0].subject)
		self.assertTrue(rows[0].link.endswith("/reentry"))
		self.assertGreaterEqual(self.mail.call_count, 1)
		# the second call (a retry, a double sync) is a no-op
		before = self.mail.call_count
		self.assertEqual(R.notify_sprayed(self._wo()), [])
		self.assertEqual(len(self._bell()), 1)
		self.assertEqual(self.mail.call_count, before)

	def test_no_intervals_means_no_restriction_and_nothing_to_clear_later(self):
		CP.max_reentry_interval_hrs.return_value = 0.0
		CP.max_phi_days.return_value = 0.0
		R.apply_spray_end(self._wo(), T0)
		v = frappe.db.get_value("Work Order", self.wo, TOUCHED, as_dict=True)
		self.assertIsNone(v.custom_harvest_after)
		self.assertEqual(v.custom_reentry_cleared_notified, 1)
		self.assertEqual(v.custom_phi_cleared_notified, 1)
		self.assertIn("No re-entry restriction", self._bell()[0].subject)
		self.assertNotIn("Harvest", self._bell()[0].subject)

	def test_scheduler_announces_each_clearing_once(self):
		R.apply_spray_end(self._wo(), T0)
		frappe.db.set_value("Work Order", self.wo, "actual_end_date", T0, update_modified=False)
		_wipe(U1)

		# too early: nothing
		self.assertEqual(R.notify_cleared(T0 + timedelta(hours=1)), {"reentry": [], "harvest": []})
		self.assertEqual(self._bell(), [])

		# re-entry over, PHI still running
		out = R.notify_cleared(T0 + timedelta(hours=13))
		self.assertIn(self.wo, out["reentry"])
		self.assertNotIn(self.wo, out["harvest"])
		self.assertIn("safe to re-enter (since 21:40)", self._bell()[0].subject)
		self.assertEqual(R.notify_cleared(T0 + timedelta(hours=14))["reentry"], [])

		# PHI over
		out = R.notify_cleared(T0 + timedelta(days=4))
		self.assertIn(self.wo, out["harvest"])
		self.assertEqual(len(self._bell()), 2)
		self.assertIn("pre-harvest interval over", self._bell()[1].subject)
		self.assertEqual(R.notify_cleared(T0 + timedelta(days=5)), {"reentry": [], "harvest": []})

	def test_scheduler_ignores_plans_that_were_never_announced(self):
		frappe.db.set_value("Work Order", self.wo, {
			"actual_end_date": T0, "custom_reentry_time": T0, "custom_reentry_notified": 0,
		}, update_modified=False)
		self.assertNotIn(self.wo, R.notify_cleared(T0 + timedelta(days=1))["reentry"])

	def test_scheduler_ignores_old_sprays(self):
		R.apply_spray_end(self._wo(), T0)
		frappe.db.set_value("Work Order", self.wo, "actual_end_date", T0, update_modified=False)
		_wipe(U1)
		out = R.notify_cleared(T0 + timedelta(days=R.LOOKBACK_DAYS + 5))
		self.assertEqual(out, {"reentry": [], "harvest": []})

	def test_status_follows_the_clocks(self):
		R.apply_spray_end(self._wo(), T0)
		frappe.db.set_value("Work Order", self.wo, "actual_end_date", T0, update_modified=False)
		house = self._wo().custom_greenhouse

		def row(now):
			rows = [r for r in R.build_status(now=now) if r["house"] == house]
			self.assertEqual(len(rows), 1)
			return rows[0]

		r = row(T0 + timedelta(hours=1))
		self.assertEqual(r["status"], "no_entry")
		self.assertEqual(r["work_order"], self.wo)
		self.assertEqual(r["reentry_time"], T0 + timedelta(hours=12))
		self.assertEqual(r["ended_at"], T0)
		self.assertTrue(r["products"])

		r = row(T0 + timedelta(hours=13))
		self.assertEqual(r["status"], "harvest_held")
		self.assertEqual(r["harvest_after"], T0 + timedelta(days=3))

		r = row(T0 + timedelta(days=4))
		self.assertEqual(r["status"], "clear")
		self.assertEqual(r["cleared_at"], T0 + timedelta(days=3))

	def test_status_respects_the_farm_scope(self):
		R.apply_spray_end(self._wo(), T0)
		frappe.db.set_value("Work Order", self.wo, "actual_end_date", T0, update_modified=False)
		house = self._wo().custom_greenhouse
		self.assertEqual(R.build_status(now=T0, farms=set()), [])
		self.assertEqual(R.build_status(now=T0, farms={"__no_such_farm__"}), [])
		farm = frappe.db.get_value("Warehouse", house, "custom_farm")
		hit = [r for r in R.build_status(now=T0, farms={farm}) if r["house"] == house]
		self.assertEqual(len(hit), 1)

	def test_api_refuses_users_without_a_role(self):
		frappe.set_user("Guest")
		try:
			with self.assertRaises(frappe.PermissionError):
				R.get_entry_status()
		finally:
			frappe.set_user("Administrator")
