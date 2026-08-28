"""The SCP manager must reach every app doctype without holding System Manager.

`System Manager` is an administrative role: it grants the whole site, not this app, so
handing it to a farm manager to let them open a Scouting Entry is a permission decision
made by accident. Before this test, 25 of the app's 43 parent doctypes could not be READ
by a real SCP General Manager who was not also a System Manager — `Pest`, `Plant Disease`,
`Trap`, `Scouting Entry`, `Scouting and Crop Protection Settings` and the logsheet among
them.

Two separate causes, which is why there are two tests:

1. **Missing rows.** 23 doctype JSONs listed `System Manager` and nothing else. Adding a
   doctype and giving it the one role that already works is the easy thing to do, and
   nothing objected.

2. **A Custom DocPerm override.** `Spray Application Logsheet`, `Sprayer Movement Session`
   and `Work Order Chemical Scan` each carried a single `Custom DocPerm` row for the
   legacy `Spray Supervisor` role. `frappe.permissions.get_valid_perms` discards *every*
   DocPerm whose parent appears in Custom DocPerm, so that one row silently switched off
   System Manager, SCP General Manager, SCP Scout and CEO on those doctypes. Nothing in
   the JSON hints at it — it is only visible on the site.

The second is the one worth guarding hardest: it is invisible in code review, survives a
migrate, and gets *worse* as JSON permissions are added, because the added rows are
discarded too.
"""

import unittest

import frappe

GM = "SCP General Manager"
SM = "System Manager"
FLAGS = ("read", "write", "create", "delete", "submit", "cancel", "amend",
         "report", "export", "share", "print", "email")


def _scp_parent_doctypes() -> list[str]:
	modules = [m.name for m in frappe.get_all(
		"Module Def", filters={"app_name": "upande_scp"}, fields=["name"])]
	return sorted(d.name for d in frappe.get_all(
		"DocType", filters={"module": ["in", modules], "istable": 0}, fields=["name"]))


def _effective_roles(doctype: str) -> set[str]:
	"""The roles that actually govern a doctype on this site.

	Custom DocPerm does not merge with DocPerm — it replaces it wholesale. Mirrors
	`frappe.permissions.get_valid_perms`.
	"""
	custom = {p.role for p in frappe.get_all(
		"Custom DocPerm", filters={"parent": doctype}, fields=["role"])}
	if custom:
		return custom
	return {p.role for p in frappe.get_all(
		"DocPerm", filters={"parent": doctype}, fields=["role"])}


class TestManagerReachesEveryDoctype(unittest.TestCase):
	def test_no_doctype_is_reachable_only_by_system_manager(self):
		"""Needing System Manager to open a doctype means granting the whole site."""
		sm_only = [
			dt for dt in _scp_parent_doctypes()
			if _effective_roles(dt) <= {SM, "Administrator"}
		]
		self.assertEqual(
			sm_only, [],
			"these require System Manager because no other role can reach them:\n  "
			+ "\n  ".join(sm_only),
		)

	def test_the_manager_matches_system_manager_everywhere(self):
		"""Anything a System Manager can do to an SCP doctype, the manager can too."""
		short = []
		for dt in _scp_parent_doctypes():
			perms = {p.role: p for p in frappe.get_all(
				"DocPerm", filters={"parent": dt}, fields=["*"])}
			sm, gm = perms.get(SM), perms.get(GM)
			if not sm:
				continue
			if not gm:
				short.append(f"{dt}: no {GM} row")
				continue
			missing = [f for f in FLAGS if sm.get(f) and not gm.get(f)]
			if missing:
				short.append(f"{dt}: {GM} lacks {', '.join(missing)}")
		self.assertEqual(short, [], "manager short of System Manager:\n  " + "\n  ".join(short))


class TestNoCustomDocPermOverride(unittest.TestCase):
	def test_no_scp_doctype_is_governed_by_custom_docperm(self):
		"""A Custom DocPerm row REPLACES the doctype's permissions rather than adding to
		them, so one stale row disables every role the JSON grants — including the ones a
		later commit adds, which is how this stayed hidden."""
		overridden = sorted({
			p.parent for p in frappe.get_all(
				"Custom DocPerm",
				filters={"parent": ["in", _scp_parent_doctypes()]},
				fields=["parent"],
			)
		})
		self.assertEqual(
			overridden, [],
			"these doctypes ignore their own permissions entirely:\n  "
			+ "\n  ".join(overridden),
		)


class TestARealManagerCanWork(unittest.TestCase):
	"""The end-to-end version: an actual user, not a permission table."""

	def test_a_manager_without_system_manager_can_read_everything(self):
		from frappe.permissions import has_permission

		gms = {u.parent for u in frappe.get_all(
			"Has Role", filters={"role": GM, "parenttype": "User"}, fields=["parent"])}
		sms = {u.parent for u in frappe.get_all(
			"Has Role", filters={"role": SM, "parenttype": "User"}, fields=["parent"])}
		candidates = sorted(gms - sms - {"Administrator", "Guest"})
		if not candidates:
			self.skipTest("no manager on this site lacks System Manager")

		user = candidates[0]
		denied = [dt for dt in _scp_parent_doctypes()
		          if not has_permission(dt, "read", user=user)]
		self.assertEqual(
			denied, [],
			f"{user} holds {GM} and not {SM}, and cannot read:\n  " + "\n  ".join(denied),
		)
