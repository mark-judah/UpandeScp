"""A role means the same thing whichever site named it.

The bug: mona carries two spellings of the same role — "General Manager" and
"SCP General Manager" — and the sidebar matched with the prefix off while the
server matched literally. A user holding the prefixed name was shown the
Approvals page and then refused its data, with an error blaming their
connection. These assert the halves now agree.
"""

import unittest

import frappe

from upande_scp.serverscripts.roles import bare, has_any_role, roles_of, spellings

USER = "_test_role_matching@example.com"


class TestBareName(unittest.TestCase):
	def test_the_prefix_comes_off(self):
		self.assertEqual(bare("SCP General Manager"), "general manager")

	def test_an_unprefixed_name_is_unchanged_but_for_case(self):
		self.assertEqual(bare("General Manager"), "general manager")

	def test_both_spellings_reduce_to_one(self):
		self.assertEqual(bare("SCP Spray Plan Approver"), bare("Spray Plan Approver"))

	def test_case_does_not_decide_access(self):
		# The site really does carry "spray plan manager" in lower case.
		self.assertEqual(bare("spray plan manager"), bare("Spray Plan Manager"))

	def test_scp_inside_a_name_is_not_a_prefix(self):
		# Only a leading "SCP " is a namespace; a role that merely contains it
		# keeps its name.
		self.assertEqual(bare("Audit SCP Reviewer"), "audit scp reviewer")

	def test_empty_and_none_are_survivable(self):
		self.assertEqual(bare(""), "")
		self.assertEqual(bare(None), "")


class TestAgainstARealUser(unittest.TestCase):
	"""The whole point is what a gate answers for a person who exists."""

	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")
		for role in ("SCP General Manager", "Spray Plan Approver"):
			if not frappe.db.exists("Role", role):
				frappe.get_doc({"doctype": "Role", "role_name": role}).insert(
					ignore_permissions=True
				)
		if not frappe.db.exists("User", USER):
			frappe.get_doc(
				{
					"doctype": "User",
					"email": USER,
					"first_name": "Role Matching",
					"send_welcome_email": 0,
					"roles": [{"role": "SCP General Manager"}],
				}
			).insert(ignore_permissions=True)
		frappe.db.commit()

	@classmethod
	def tearDownClass(cls):
		if frappe.db.exists("User", USER):
			frappe.delete_doc("User", USER, force=True, ignore_permissions=True)
		frappe.db.commit()

	def test_a_gate_written_unprefixed_accepts_the_prefixed_holder(self):
		"""This is the reported failure, in one line: the user holds
		"SCP General Manager" and every server gate asks for "General Manager"."""
		self.assertTrue(has_any_role("General Manager", user=USER))

	def test_a_gate_written_prefixed_accepts_them_too(self):
		self.assertTrue(has_any_role("SCP General Manager", user=USER))

	def test_a_role_they_do_not_hold_is_still_refused(self):
		"""The widening is to spelling, not to access."""
		self.assertFalse(has_any_role("Spray Plan Approver", user=USER))
		self.assertFalse(has_any_role("SCP Spray Plan Approver", user=USER))

	def test_a_tuple_of_roles_passes_through(self):
		# The call sites hold their roles in tuples and sets already.
		self.assertTrue(has_any_role(("Spray Plan Approver", "General Manager"), user=USER))
		self.assertFalse(has_any_role(("Spray Supervisor", "Item Manager"), user=USER))

	def test_several_arguments_work_like_an_or(self):
		self.assertTrue(has_any_role("Spray Plan Approver", "General Manager", user=USER))

	def test_roles_of_reports_bare_names(self):
		self.assertIn("general manager", roles_of(USER))


class TestBothSpellings(unittest.TestCase):
	"""``spray_plan_creator.bulk`` queries the database directly rather than
	reading the role cache, so it cannot compare bare names in Python — it has
	to ask after each name the role goes by."""

	def test_a_bare_name_yields_both(self):
		self.assertEqual(spellings("General Manager"), ("General Manager", "SCP General Manager"))

	def test_a_prefixed_name_yields_the_same_pair(self):
		self.assertEqual(spellings("SCP General Manager"), spellings("General Manager"))

	def test_the_pair_is_not_doubled_up(self):
		bare_name, prefixed = spellings("Spray Plan Approver")
		self.assertNotEqual(bare_name, prefixed)
