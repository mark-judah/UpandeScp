"""Stage.stage_role from the stage name (stage & variety spec S2).

Sign = Damage, Damages, FCM Damage, Web, Ragged Margins; Form = Motiles, Singles,
Colonies, Scales, Scale Insects, Adult Cloud, Adult Singles; every other stage a
Life stage. FILLS BLANKS ONLY: a role already set — by an agronomist, or by an
earlier run — stands, so the patch is safe to rerun. Weights are not touched:
the column defaults to 1.0 and the agronomist sets real ones.
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
	stage_roles.invalidate_stage_roles()
	# Pest prevalence cached before this ran counted signs as the pest.
	from upande_scp.serverscripts.dashboard_aggregates import _common

	frappe.cache().delete_value(_common.K_DASH_AGG_BUMP_LOCK)  # the bump is debounced; this one must happen
	_common.bump_dash_agg_version()
