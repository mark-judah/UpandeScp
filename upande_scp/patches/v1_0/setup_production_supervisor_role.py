"""The SCP Production Supervisor role: whoever sends pickers into the houses.

Told when a house is sprayed, when it is safe to re-enter and when harvest may
resume (spray_plan_creator.reentry), and sees the Re-entry board. Read-only: it
grants no document permissions, because the board and API gate on the role and the
farm roster, not on Work Order access. Admitted to the SCP workspace so the desk
tile is not a dead end for someone who holds only this role.

Idempotent.
"""

import frappe

ROLE = "SCP Production Supervisor"
WORKSPACE = "SCP"
DESC = (
	"Production: is told when a house is sprayed, when it is safe to re-enter and "
	"when harvest may resume, and sees the Re-entry board."
)


def execute():
	if not frappe.db.exists("Role", ROLE):
		frappe.get_doc(
			{"doctype": "Role", "role_name": ROLE, "desk_access": 1, "disabled": 0, "description": DESC}
		).insert(ignore_permissions=True)
	for name in (WORKSPACE, "Upande SCP"):
		if not frappe.db.exists("Workspace", name):
			continue
		doc = frappe.get_doc("Workspace", name)
		if ROLE in {r.role for r in doc.roles}:
			return
		doc.append("roles", {"role": ROLE})
		doc.flags.ignore_permissions = True
		doc.save(ignore_permissions=True)
		return
