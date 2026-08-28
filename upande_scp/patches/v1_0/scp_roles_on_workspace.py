"""Let the app's own roles reach the app's own workspace.

`namespace_scp_roles` made the app self-contained by moving every grant onto `SCP `
roles. It did not touch the **workspace**, whose visibility is a separate role list on
the Workspace record — so `Upande SCP` still admitted only `System Manager` and the
legacy `Scouting & Crop Protection User`.

The effect was that the SCP desk icon led nowhere for anyone holding only the new roles.
It looked fine to whoever checked, because the people most likely to check were the ones
who happened to still carry the legacy role: on kaitet, Peter Kamuren (SCP General
Manager) saw the workspace and Elvis Koskei (SCP General Manager) did not, and the only
difference between them was `Scouting & Crop Protection User`.

Non-destructive and idempotent: the existing roles stay, since the legacy role is still
held by 188 users and removing it here would take the workspace away from them. Frappe
filters the cards and shortcuts inside a workspace by document permission anyway, so
admitting a role costs it nothing it is not already entitled to see.
"""

import frappe

WORKSPACE = "Upande SCP"

SCP_ROLES = (
	"SCP General Manager",
	"SCP Scout",
	"SCP Scouting User",
	"SCP Chemical Store Keeper",
	"SCP Spray Supervisor",
	"SCP Spray Plan Creator",
	"SCP Spray Plan Approver",
)


def execute():
	if not frappe.db.exists("Workspace", WORKSPACE):
		return  # site does not have the workspace (fresh install builds it later)

	doc = frappe.get_doc("Workspace", WORKSPACE)
	held = set()
	for row in doc.roles:
		held.add(row.role)

	added = []
	for role in SCP_ROLES:
		if role in held or not frappe.db.exists("Role", role):
			continue
		doc.append("roles", {"role": role})
		added.append(role)

	if not added:
		return

	doc.flags.ignore_permissions = True
	doc.save(ignore_permissions=True)
	frappe.db.commit()
	print(f"[scp-roles] {WORKSPACE}: admitted {len(added)} role(s) — {', '.join(added)}")
