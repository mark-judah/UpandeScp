"""One-off data fix (spec S10): give every Spray Team its `custom_farm`.

Uses the bootstrap rule — the farm's name inside the team's name, longest
match wins (`exposure_rules.match_team_farm`). A team that already has a farm
is left alone. Returns what it set and what it could not match.

    bench --site kaitet.local execute \
        upande_scp.serverscripts.sprayers.team_farms.assign_team_farms
"""

import frappe

from upande_scp.serverscripts.common.exposure_rules import match_team_farm


def assign_team_farms(dry_run=False) -> dict:
	farms = frappe.get_all("Farm", pluck="name")
	set_, unmatched, kept = {}, [], {}
	for t in frappe.get_all("Spray Team", fields=["name", "custom_farm"], order_by="name"):
		if t.custom_farm:
			kept[t.name] = t.custom_farm
			continue
		farm = match_team_farm(t.name, farms)
		if not farm:
			unmatched.append(t.name)
			continue
		set_[t.name] = farm
		if not dry_run:
			# set_value, not save: the on_update sync runs once afterwards for
			# every team rather than once per team.
			frappe.db.set_value("Spray Team", t.name, "custom_farm", farm)
	return {"set": set_, "kept": kept, "unmatched": unmatched}
