"""Whichever name a General Manager's role goes by, they can open Spray Product.

Five of mona's six General Managers could not. Spray Product's permissions name
only the SCP-prefixed roles, and Frappe's permission system matches role names
exactly — it cannot be taught that "General Manager" and "SCP General Manager"
are the same role the way this app's own gates now are. Only the GM who is also
a System Manager got in, which is why it read as "the list is empty" rather
than as a permissions problem.

Guarded here rather than left to the patch alone: a later export of
`custom_docperm` fixtures, or somebody tidying the Role Permissions Manager,
would put it straight back without anything failing.
"""

import unittest

import frappe

DOCTYPE = "Spray Product"
PREFIX = "SCP "


def _plain_rows():
	"""Effective permission rows, as Frappe will actually read them."""
	table = "Custom DocPerm" if frappe.db.count("Custom DocPerm", {"parent": DOCTYPE}) else "DocPerm"
	return frappe.get_all(
		table,
		filters={"parent": DOCTYPE, "if_owner": 0},
		fields=["role", "permlevel", "read"],
	)


class TestSprayProductReachesBothRoleFamilies(unittest.TestCase):
	def test_every_scp_role_has_an_unprefixed_twin_that_can_read(self):
		rows = _plain_rows()
		readable = {
			(r.role, int(r.permlevel or 0)) for r in rows if int(r.read or 0)
		}
		missing = []
		for role, permlevel in list(readable):
			if not role.startswith(PREFIX):
				continue
			plain = role[len(PREFIX) :]
			if not frappe.db.exists("Role", plain):
				# Nothing holds it; the patch skips these on purpose.
				continue
			if (plain, permlevel) not in readable:
				missing.append(f"{plain} (permlevel {permlevel})")
		self.assertEqual(
			missing,
			[],
			f"{DOCTYPE} is readable as SCP-prefixed roles but not as: {missing}",
		)

	def test_a_general_manager_can_actually_read_it(self):
		"""The rows are the mechanism; this is the thing that was broken."""
		gms = frappe.get_all(
			"Has Role",
			filters={"role": "General Manager", "parenttype": "User"},
			pluck="parent",
		)
		gms = [
			u
			for u in set(gms)
			if u not in ("Administrator", "Guest")
			and frappe.db.get_value("User", u, "enabled")
		]
		if not gms:
			self.skipTest("no enabled General Manager on this site")

		original = frappe.session.user
		try:
			for user in sorted(gms):
				frappe.set_user(user)
				self.assertTrue(
					frappe.has_permission(DOCTYPE, "read"),
					f"{user} holds General Manager but cannot read {DOCTYPE}",
				)
		finally:
			frappe.set_user(original)
