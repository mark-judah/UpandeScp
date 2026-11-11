"""Lateness grading, the missed cutoff, midnight-safe postponement and no-past planning.

Pure logic mostly; the one DB-reading piece (`cutoff_for`) is exercised through the
settings default. Run: bench --site kaitet.local run-tests \
        --module upande_scp.serverscripts.tests.test_lateness
"""
import unittest
from datetime import datetime

import frappe

from upande_scp.serverscripts.mobile.create_scouting_entry import clamp_future_capture
from upande_scp.serverscripts.spray_plan_creator import lateness as L
from upande_scp.serverscripts.spray_plan_creator import postponement as P

PLAN = datetime(2026, 11, 11, 6, 0)  # window 06:00 -> 22:00


def g(now, **kw):
	return L.grade(PLAN, now, kw.pop("cutoff", "22:00:00"), **kw)


class TestGrade(unittest.TestCase):
	def test_not_late_before_the_planned_time(self):
		self.assertEqual(g(datetime(2026, 11, 11, 5, 59))["level"], "none")

	def test_levels_across_the_window(self):
		self.assertEqual(g(datetime(2026, 11, 11, 6, 0))["level"], "amber")
		self.assertEqual(g(datetime(2026, 11, 11, 13, 59))["level"], "amber")
		self.assertEqual(g(datetime(2026, 11, 11, 14, 0))["level"], "orange")
		self.assertEqual(g(datetime(2026, 11, 11, 20, 24))["level"], "red")
		self.assertEqual(g(datetime(2026, 11, 11, 22, 0))["level"], "red")

	def test_missed_only_after_the_cutoff(self):
		self.assertFalse(g(datetime(2026, 11, 11, 22, 0))["missed"])
		self.assertTrue(g(datetime(2026, 11, 11, 22, 0, 1))["missed"])
		self.assertTrue(g(datetime(2026, 11, 12, 3, 0))["missed"])

	def test_a_plan_that_is_spraying_or_stopped_is_never_late(self):
		self.assertEqual(g(datetime(2026, 11, 12, 3, 0), open_plan=False)["level"], "none")

	def test_cutoff_is_per_call(self):
		self.assertTrue(g(datetime(2026, 11, 11, 12, 30), cutoff="12:00:00")["missed"])

	def test_cutoff_never_before_the_plan(self):
		late_plan = datetime(2026, 11, 11, 23, 0)
		out = L.grade(late_plan, datetime(2026, 11, 11, 23, 10), "22:00:00")
		self.assertFalse(out["missed"])

	def test_default_cutoff_is_2200_when_unset(self):
		self.assertEqual(L.DEFAULT_CUTOFF, "22:00:00")


class TestMidnightPostponement(unittest.TestCase):
	def test_a_date_only_target_keeps_the_plans_time(self):
		t = P.with_time_of_day("2026-11-12", datetime(2026, 11, 10, 7, 30))
		self.assertEqual(t, datetime(2026, 11, 12, 7, 30))

	def test_a_midnight_target_keeps_the_plans_time(self):
		t = P.with_time_of_day("2026-11-12 00:00:00", datetime(2026, 11, 10, 7, 30))
		self.assertEqual(t, datetime(2026, 11, 12, 7, 30))

	def test_no_plan_time_falls_back_to_0600(self):
		self.assertEqual(P.with_time_of_day("2026-11-12", None), datetime(2026, 11, 12, 6, 0))

	def test_an_explicit_time_is_respected(self):
		t = P.with_time_of_day("2026-11-12 14:15:00", datetime(2026, 11, 10, 7, 30))
		self.assertEqual(t, datetime(2026, 11, 12, 14, 15))


class TestNoPast(unittest.TestCase):
	NOW = datetime(2026, 11, 11, 10, 0, 0)

	def setUp(self):
		frappe.flags.enforce_past_guard = True

	def tearDown(self):
		frappe.flags.enforce_past_guard = False

	def test_past_time_is_refused(self):
		with self.assertRaises(frappe.ValidationError):
			L.assert_not_in_past("2026-11-11 09:00:00", now=self.NOW)

	def test_tolerance_is_only_latency(self):
		L.assert_not_in_past("2026-11-11 09:59:30", now=self.NOW)
		with self.assertRaises(frappe.ValidationError):
			L.assert_not_in_past("2026-11-11 09:58:00", now=self.NOW)

	def test_now_and_future_pass(self):
		L.assert_not_in_past("2026-11-11 10:00:00", now=self.NOW)
		L.assert_not_in_past("2026-11-12 06:00:00", now=self.NOW)

	def test_a_date_alone_means_that_day(self):
		L.assert_not_in_past("2026-11-11", now=self.NOW)
		with self.assertRaises(frappe.ValidationError):
			L.assert_not_in_past("2026-11-10", now=self.NOW)

	def test_editing_without_changing_the_date_is_not_rechecked(self):
		L.assert_not_in_past("2026-11-10 06:00:00", previous="2026-11-10 06:00:00", now=self.NOW)
		with self.assertRaises(frappe.ValidationError):
			L.assert_not_in_past("2026-11-10 07:00:00", previous="2026-11-10 06:00:00", now=self.NOW)

	def test_no_schedule_is_left_to_the_other_checks(self):
		L.assert_not_in_past(None)


class TestFutureCaptureClamp(unittest.TestCase):
	NOW = datetime(2026, 11, 11, 10, 0, 0)

	def test_within_tolerance_untouched(self):
		self.assertEqual(
			clamp_future_capture("2026-11-11", "10:04:00", now=self.NOW),
			("2026-11-11", "10:04:00", False),
		)

	def test_far_future_clamped_to_now_not_refused(self):
		d, t, clamped = clamp_future_capture("2026-11-11", "13:00:00", now=self.NOW)
		self.assertEqual((d, t, clamped), ("2026-11-11", "10:00:00", True))

	def test_next_day_stamp_clamped(self):
		self.assertTrue(clamp_future_capture("2026-11-12", "01:00:00", now=self.NOW)[2])

	def test_garbage_passes_through(self):
		self.assertEqual(clamp_future_capture(None, None), (None, None, False))
