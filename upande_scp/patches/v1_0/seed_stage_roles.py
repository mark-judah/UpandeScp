"""Stage.stage_role from the stage name (stage & variety spec S2).

Sign = Damage, Damages, FCM Damage, Web, Ragged Margins; Form = Motiles, Singles,
Colonies, Scales, Scale Insects, Adult Cloud, Adult Singles; every other stage a
Life stage. FILLS BLANKS ONLY: a role already set — by an agronomist, or by an
earlier run — stands, so the patch is safe to rerun. Weights are not touched:
unset weights (NULL / 0 on a freshly added column) become the neutral 1.0 and the
agronomist sets real ones.
"""

import frappe

from upande_scp.serverscripts.common import stage_roles


def execute():
	if not frappe.db.has_column("Stage", "stage_role"):
		return
	for name, role in frappe.db.sql("select name, stage_role from `tabStage`"):
		if (role or "").strip():
			continue
		frappe.db.set_value("Stage", name, "stage_role", stage_roles.seed_role(name), update_modified=False)
	# A column added to a populated table reads 0.0 on every existing row, and a
	# weight of 0 means "left out of the Count". Nobody has set a weight yet (the
	# field did not exist), so every unset one is the neutral 1.0.
	if frappe.db.has_column("Stage", "weight"):
		frappe.db.sql("update `tabStage` set weight = 1 where weight is null or weight = 0")
	stage_roles.invalidate_stage_roles()
	# Pest prevalence cached before this ran counted signs as the pest. The
	# dashboard-aggregate version stamp arrives with the dashboard_aggregates
	# port; until then there is nothing cached under it to drop.
	try:
		from upande_scp.serverscripts.dashboard_aggregates import _common
	except ImportError:
		return
	if hasattr(_common, "bump_dash_agg_version"):
		lock = getattr(_common, "K_DASH_AGG_BUMP_LOCK", None)
		if lock:
			frappe.cache().delete_value(lock)  # the bump is debounced; this one must happen
		_common.bump_dash_agg_version()
