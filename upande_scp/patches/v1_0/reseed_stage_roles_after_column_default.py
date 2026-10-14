"""Give Stage.stage_role its seed values on sites where the column arrived pre-filled.

On mona, adding ``Stage.stage_role`` to the populated table left every row reading
"Life stage" (the Select's first option), so ``seed_stage_roles`` - which fills
blanks only - found nothing blank and every Sign / Form stayed a Life stage.
Nobody could have set a role before the field existed, so a row still reading
"Life stage" whose seed role is Form or Sign is simply the column default.
Only ever upgrades such a row; any other value stands. Idempotent.
"""

import frappe

from upande_scp.serverscripts.common import stage_roles


def execute():
	if not frappe.db.has_column("Stage", "stage_role"):
		return
	changed = 0
	for name, role in frappe.db.sql("select name, stage_role from `tabStage`"):
		if (role or "").strip() not in ("", stage_roles.LIFE_STAGE):
			continue
		want = stage_roles.seed_role(name)
		if want != (role or "").strip():
			frappe.db.set_value("Stage", name, "stage_role", want, update_modified=False)
			changed += 1
	if changed:
		stage_roles.invalidate_stage_roles()
		print(f"[scp-stage-roles] reseeded {changed} stage role(s)")
