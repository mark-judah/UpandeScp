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


# ─────────────────────────── every role, not just the manager ────────────────

#: What each app role must be able to do, derived from the writes in `serverscripts`
#: that do NOT pass `ignore_permissions` — those are the only places DocPerms are
#: actually enforced, so they are the only places a missing grant becomes an outage.
#:
#: `create_scouting_entry.createScoutingEntry` calls `.insert()` plainly, and before
#: this list existed `SCP Scout` had permissions on exactly one doctype — `Spray
#: Application Logsheet`, a spray document — so a real scout got `PermissionError`
#: inserting a Scouting Entry. 147 users hold that role and nothing else elevated.
_SCOUT_MASTERS = ("Pest", "Plant Disease", "Weed", "Predator", "Physiological Disorder",
                  "Trap", "Stage", "Pest Filter", "Disease Filter", "Crop Scouted",
                  "Plant Section", "Scouting and Crop Protection Settings", "Map Settings")

_SCOUTING = dict([("Scouting Entry", "rwc"), ("Scouting Entry Metadata", "rwc")]
                 + [(m, "r") for m in _SCOUT_MASTERS])

ROLE_REQUIREMENTS: dict[str, dict[str, str]] = {
	# r=read w=write c=create s=submit
	"SCP Scout": _SCOUTING,
	"SCP Scouting User": _SCOUTING,
	"SCP Spray Supervisor": {
		# spray_session.py inserts the logsheet, the movement session and the scan
		# rows under the supervisor's own session.
		"Spray Application Logsheet": "rwcs", "Sprayer Movement Session": "rwc",
		"Spray Session Token": "rc", "Chemical QR Label": "r",
		"Chemical": "r", "Foliar": "r", "Scouting and Crop Protection Settings": "r",
	},
	"SCP Chemical Store Keeper": {
		"Chemical": "rwc", "Foliar": "rwc",
		"Chemical Crop Profile": "rwc", "Foliar Crop Profile": "rwc",
		# Labels are minted by `stock_entry_state.on_submit` -> `issue_for_stock_entry`,
		# which runs as whoever submits the transfer: the store keeper.
		"Chemical QR Label": "rwc", "Chemical Transfer Request": "rwc",
		"Chemical Procurement Cycle": "r", "Chemical Purchase Requirement": "r",
		"Scouting and Crop Protection Settings": "r",
	},
	"SCP Spray Plan Creator": {
		"Chemical Purchase Requirement": "rwc", "Chemical Requirement Amendment": "rwc",
		"Chemical Transfer Request": "rwc",
		"Chemical": "r", "Foliar": "r", "Chemical Crop Profile": "r",
		"Foliar Crop Profile": "r", "Spray Plan Postponement": "r",
		"Scouting and Crop Protection Settings": "r",
	},
	"SCP Spray Plan Approver": {
		"Spray Plan Postponement": "rw", "Chemical": "r", "Foliar": "r",
		"Scouting and Crop Protection Settings": "r",
	},
}

_LETTER = {"r": "read", "w": "write", "c": "create", "s": "submit"}


class TestEveryRoleReachesItsDoctypes(unittest.TestCase):
	def test_each_role_has_what_its_code_path_writes(self):
		gaps = []
		for role, wants in ROLE_REQUIREMENTS.items():
			held = {}
			for row in frappe.get_all("DocPerm", filters={"role": role}, fields=["*"]):
				held[row["parent"]] = row
			for dt, letters in wants.items():
				row = held.get(dt)
				missing = []
				for ch in letters:
					flag = _LETTER[ch]
					if not row or not row.get(flag):
						missing.append(flag)
				if missing:
					gaps.append(f"{role} -> {dt}: {', '.join(missing)}")
		self.assertEqual(gaps, [], "roles short of their own doctypes:\n  " + "\n  ".join(gaps))

	def test_a_real_scout_can_create_a_scouting_entry(self):
		"""The end-to-end version. `createScoutingEntry` inserts without
		`ignore_permissions`, so a missing grant here is a scout who cannot scout."""
		elevated = set()
		for r in ("System Manager", "SCP General Manager"):
			for u in frappe.get_all("Has Role", filters={"role": r, "parenttype": "User"},
			                        fields=["parent"]):
				elevated.add(u.parent)
		scouts = []
		for u in frappe.get_all("Has Role", filters={"role": "SCP Scout", "parenttype": "User"},
		                        fields=["parent"]):
			if u.parent not in elevated and u.parent not in ("Administrator", "Guest"):
				scouts.append(u.parent)
		if not scouts:
			self.skipTest("no scout on this site lacks an elevated role")

		from frappe.permissions import has_permission
		user = sorted(scouts)[0]
		for flag in ("read", "create", "write"):
			self.assertTrue(
				has_permission("Scouting Entry", flag, user=user),
				f"{user} holds SCP Scout and cannot {flag} a Scouting Entry",
			)


# ────────────────────── the doctypes approval borrows from ───────────────────

#: Not ours, but the manager cannot approve a spray plan without them. The approval
#: endpoints write with `ignore_permissions=True`, so these are about the desk and the
#: REST client rather than the server path — which is exactly why they are easy to
#: break without noticing.
APPROVAL_PATH: dict[str, str] = {
	"Work Order": "rw", "Stock Entry": "rwcs", "BOM": "r", "Item": "r",
	"Warehouse": "r", "Bin": "r", "Cost Center": "r", "Farm": "r",
}


class TestManagerCanApprove(unittest.TestCase):
	"""Checked per USER, not per role.

	`SCP General Manager` does not itself grant `Work Order` or `Stock Entry`, and should
	not — those belong to ERPNext's own roles. What matters is that the people who
	actually approve hold a role bundle that reaches them without `System Manager`. So
	this asserts against a real approver rather than a permission table, which is also
	the only form that would have caught the Custom DocPerm override.
	"""

	def _an_approver_without_system_manager(self):
		elevated = set()
		for u in frappe.get_all("Has Role", filters={"role": SM, "parenttype": "User"},
		                        fields=["parent"]):
			elevated.add(u.parent)
		candidates = []
		for u in frappe.get_all("Has Role", filters={"role": GM, "parenttype": "User"},
		                        fields=["parent"]):
			if u.parent not in elevated and u.parent not in ("Administrator", "Guest"):
				candidates.append(u.parent)
		return sorted(candidates)

	def test_an_approver_reaches_the_doctypes_approval_borrows(self):
		from frappe.permissions import has_permission

		users = self._an_approver_without_system_manager()
		if not users:
			self.skipTest("no manager on this site lacks System Manager")
		user = users[0]

		gaps = []
		for dt, letters in APPROVAL_PATH.items():
			if not frappe.db.exists("DocType", dt):
				continue
			for ch in letters:
				flag = _LETTER[ch]
				if not has_permission(dt, flag, user=user):
					gaps.append(f"{dt}: {flag}")
		self.assertEqual(
			gaps, [],
			f"{user} holds {GM} and not {SM}, and cannot use these during approval:\n  "
			+ "\n  ".join(gaps),
		)


class TestTheWorkspaceAdmitsTheAppsRoles(unittest.TestCase):
	"""Permission on a doctype and admission to the workspace are separate gates.

	A Workspace carries its own role list. `namespace_scp_roles` moved every document
	grant onto the `SCP ` roles and left that list naming only `System Manager` and the
	legacy `Scouting & Crop Protection User`, so the SCP desk icon led nowhere for anyone
	holding just the new roles — while looking fine to whoever checked, because they
	usually still carried the legacy role too.
	"""

	WORKSPACE = "Upande SCP"

	def test_every_scp_role_is_admitted_to_the_workspace(self):
		if not frappe.db.exists("Workspace", self.WORKSPACE):
			self.skipTest(f"{self.WORKSPACE} does not exist on this site")

		admitted = set()
		for row in frappe.get_all("Has Role",
		                          filters={"parenttype": "Workspace", "parent": self.WORKSPACE},
		                          fields=["role"]):
			admitted.add(row["role"])

		missing = []
		for role in ROLE_REQUIREMENTS:
			if role not in admitted:
				missing.append(role)
		if GM not in admitted:
			missing.append(GM)
		self.assertEqual(
			missing, [],
			f"these roles cannot open {self.WORKSPACE}: " + ", ".join(missing),
		)

	def test_a_manager_without_the_legacy_role_can_open_it(self):
		"""The end-to-end version — the table being right is not the page opening."""
		import json

		from frappe.desk.desktop import get_desktop_page

		if not frappe.db.exists("Workspace", self.WORKSPACE):
			self.skipTest(f"{self.WORKSPACE} does not exist on this site")

		elevated = set()
		for u in frappe.get_all("Has Role", filters={"role": SM, "parenttype": "User"},
		                        fields=["parent"]):
			elevated.add(u.parent)
		for u in frappe.get_all("Has Role",
		                        filters={"role": "Scouting & Crop Protection User",
		                                 "parenttype": "User"},
		                        fields=["parent"]):
			elevated.add(u.parent)

		candidates = []
		for u in frappe.get_all("Has Role", filters={"role": GM, "parenttype": "User"},
		                        fields=["parent"]):
			if u.parent not in elevated and u.parent not in ("Administrator", "Guest"):
				candidates.append(u.parent)
		if not candidates:
			self.skipTest("every manager here also holds System Manager or the legacy role")

		user = sorted(candidates)[0]
		original = frappe.session.user
		try:
			frappe.set_user(user)
			page = get_desktop_page(json.dumps({"name": self.WORKSPACE}))
			self.assertIsInstance(page, dict, f"{user} could not open {self.WORKSPACE}")
		finally:
			frappe.set_user(original)
