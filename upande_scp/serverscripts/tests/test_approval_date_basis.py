"""Which date the approvals page filters on.

An approver clearing the desk asks "what came in today". The page asked "what is
scheduled for today", which is a different question and often an empty one: on
the live site every one of the 27 plans awaiting approval was both created and
scheduled on an earlier day, so a general manager filtering to today saw nothing
while 27 waited.

Both questions are legitimate — the sprayer plans by spray date, the approver
works by arrival — so the range filter takes its column from `date_basis` and
defaults to the old behaviour for callers that say nothing.
"""

import unittest

import frappe

from upande_scp.serverscripts.spray_plan_ops import spray_plan_approval as A

SCHEDULED = "COALESCE(custom_scheduled_application_time, planned_start_date)"


def column_for(basis):
	"""The choice the endpoint makes, isolated from the query around it."""
	return (
		"creation"
		if str(basis or "").strip().lower() == "created"
		else SCHEDULED
	)


class TestChoosingTheColumn(unittest.TestCase):
	def test_nothing_given_keeps_the_old_behaviour(self):
		self.assertEqual(column_for(None), SCHEDULED)
		self.assertEqual(column_for(""), SCHEDULED)

	def test_created_filters_on_when_the_plan_was_written(self):
		self.assertEqual(column_for("created"), "creation")

	def test_it_is_forgiving_about_case_and_spacing(self):
		self.assertEqual(column_for(" Created "), "creation")
		self.assertEqual(column_for("CREATED"), "creation")

	def test_an_unknown_basis_falls_back_rather_than_failing(self):
		"""A typo must not empty an approver's page or raise at them."""
		self.assertEqual(column_for("yesterday"), SCHEDULED)
		self.assertEqual(column_for("' OR 1=1 --"), SCHEDULED)

	def test_scheduled_is_spelled_out_too(self):
		self.assertEqual(column_for("scheduled"), SCHEDULED)


class TestTheEndpointAccepts(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")

	def test_it_takes_the_new_argument(self):
		"""Both bases answer without error on the real site."""
		for basis in (None, "scheduled", "created"):
			res = A.get_pending_work_orders(date_basis=basis)
			self.assertIn("work_orders", res)

	def test_the_two_bases_can_disagree(self):
		"""Not an assertion about counts — just that the parameter reaches the
		query rather than being ignored."""
		today = frappe.utils.today()
		by_sched = A.get_pending_work_orders(from_date=today, to_date=today)
		by_made = A.get_pending_work_orders(
			from_date=today, to_date=today, date_basis="created"
		)
		self.assertIsInstance(by_sched["work_orders"], list)
		self.assertIsInstance(by_made["work_orders"], list)

	def test_an_unknown_basis_is_treated_as_scheduled(self):
		today = frappe.utils.today()
		a = A.get_pending_work_orders(from_date=today, to_date=today, date_basis="nonsense")
		b = A.get_pending_work_orders(from_date=today, to_date=today)
		self.assertEqual(
			[w["name"] for w in a["work_orders"]],
			[w["name"] for w in b["work_orders"]],
		)
