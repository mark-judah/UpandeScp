"""Spray team rules for a plan: someone to do the work, someone in charge.

* A plan with a team needs at least one member (hard rule, not a setting).
* It needs one or two Supervisor rows. Zero or three-plus is refused (hard rule).
* Each supervisor needs a user account holding "SCP Spray Supervisor", or they cannot run
  the spray on the phone. What a miss *does* follows ``spray_supervisor_role_check``
  (Off / Warn / Block, blank reads as Warn) — the same convention as the crew leave check.

``evaluate`` is pure over a roster and a lookup, so it is tested without a database.
``check_roster`` is the database-backed version; ``enforce`` raises / returns warnings at
the save and submit points, and ``check_spray_team`` is the live endpoint the planner
form calls when the team or supervisor changes.
"""

from __future__ import annotations

import frappe
from frappe.utils import cint

from upande_scp.serverscripts.common import crew_availability as CA

SETTINGS = "Scouting and Crop Protection Settings"
SUPERVISOR_ROLE = "SCP Spray Supervisor"
MAX_SUPERVISORS = 2

OK, MISSING_ROLE, NO_USER = "ok", "missing_role", "no_user"

NO_MEMBERS = (
	"This spray team has no members. Add at least one person, including a supervisor "
	"to take charge, before saving the plan."
)
NO_SUPERVISOR = (
	"This plan has no spray supervisor. Mark one team member as Supervisor so that "
	"someone is in charge of the spray."
)
NO_TEAM = (
	"This plan has no spray team. Choose the team that will carry out the spray, with a "
	"supervisor to take charge, before saving the plan."
)
TEAM_FIELD = "spray_plan_requires_team"
TOO_MANY_SUPERVISORS = (
	"A plan can have at most {max} spray supervisors, and this one has {n}. "
	"Change the extra people to Sprayer or Pump Operator."
)


def mode() -> str:
	"""Blank or unknown reads as Warn."""
	try:
		raw = frappe.db.get_single_value(SETTINGS, "spray_supervisor_role_check")
	except Exception:  # field not migrated yet: behave as blank (Warn)
		frappe.clear_last_message()
		raw = None
	return CA.normalise_mode(raw)


def team_mode() -> str:
	"""Plans with no team at all. Blank reads as Block (the GM relaxes it, e.g. for
	open-field work done without a spray team)."""
	try:
		raw = frappe.db.get_single_value(SETTINGS, TEAM_FIELD)
	except Exception:  # field not migrated yet: behave as blank
		frappe.clear_last_message()
		raw = None
	return CA.normalise_mode(raw) if (raw or "").strip() else CA.BLOCK


def no_team_verdict(team_mode_value: str) -> tuple[list[str], list[str]]:
	"""``(errors, warnings)`` for a plan with no team and no members."""
	m = CA.normalise_mode(team_mode_value)
	if m == CA.OFF:
		return [], []
	return ([NO_TEAM], []) if m == CA.BLOCK else ([], [NO_TEAM])


def role_message(name: str, status: str) -> str:
	if status == MISSING_ROLE:
		return (
			f"{name}, chosen as spray supervisor, does not have the Spray Supervisor role on "
			"their user account, so they will not be able to run this spray on the phone. "
			"Ask IT to assign the role before tomorrow to avoid a hold-up."
		)
	if status == NO_USER:
		return (
			f"{name}, chosen as spray supervisor, has no active user account linked to their "
			"employee record, so they will not be able to run this spray on the phone. "
			"Ask IT to create or link a user and assign the Spray Supervisor role before "
			"tomorrow to avoid a hold-up."
		)
	return ""


def _user_has_role(user: str) -> bool:
	if frappe.db.exists("Has Role", {"parenttype": "User", "parent": user, "role": SUPERVISOR_ROLE}):
		return True
	# A role profile grants the role even if the User's own rows have not been refreshed.
	profiles = frappe.get_all("User Role Profile", filters={"parent": user}, pluck="role_profile")
	legacy = frappe.db.get_value("User", user, "role_profile_name")
	if legacy:
		profiles.append(legacy)
	if not profiles:
		return False
	return bool(
		frappe.db.exists("Has Role", {"parenttype": "Role Profile", "parent": ["in", profiles], "role": SUPERVISOR_ROLE})
	)


def supervisor_status(employee: str) -> dict:
	"""``{employee, employee_name, status, message}`` for one would-be supervisor."""
	emp = frappe.db.get_value("Employee", employee, ["employee_name", "user_id"], as_dict=True) or {}
	name = emp.get("employee_name") or employee
	user = emp.get("user_id")
	if not user or not frappe.db.get_value("User", user, "enabled"):
		status = NO_USER
	elif _user_has_role(user):
		status = OK
	else:
		status = MISSING_ROLE
	return {"employee": employee, "employee_name": name, "status": status, "message": role_message(name, status)}


def evaluate(members: list[dict], role_mode: str, lookup=supervisor_status) -> dict:
	"""``{mode, errors, warnings, supervisors}``. ``errors`` refuse in every mode."""
	role_mode = CA.normalise_mode(role_mode)
	errors: list[str] = []
	warnings: list[str] = []
	people = [m for m in members if (m.get("employee") or "").strip()]
	if not people:
		return {"mode": role_mode, "errors": [NO_MEMBERS], "warnings": [], "supervisors": []}
	sups = [m["employee"].strip() for m in people if (m.get("role") or "").strip() == "Supervisor"]
	if not sups:
		errors.append(NO_SUPERVISOR)
	elif len(sups) > MAX_SUPERVISORS:
		errors.append(TOO_MANY_SUPERVISORS.format(max=MAX_SUPERVISORS, n=len(sups)))
	results = [lookup(e) for e in sups] if role_mode != CA.OFF else []
	for r in results:
		if r["status"] != OK:
			(errors if role_mode == CA.BLOCK else warnings).append(r["message"])
	return {"mode": role_mode, "errors": errors, "warnings": warnings, "supervisors": results}


def effective_roster(team: str | None, rows: list[dict] | None) -> list[dict]:
	"""Per-plan rows, or the master team when the plan carries none (what the spray
	flow itself falls back to)."""
	if rows:
		return rows
	if not team:
		return []
	return [
		{"employee": r.name1, "role": r.role}
		for r in frappe.get_all("Spray Team Details", filters={"parent": team}, fields=["name1", "role"])
	]


def enforce(wo, rows_sent: bool = True) -> list[str]:
	"""Refuse a bad team on a plan; return the warnings otherwise.

	No team and no members follows ``spray_plan_requires_team`` (blank = Block)."""
	rows = [{"employee": r.employee, "role": r.role} for r in (wo.custom_spray_plan_team_members or [])]
	if not wo.custom_spray_team and not rows:
		errors, warnings = no_team_verdict(team_mode())
		if errors:
			frappe.throw("<br>".join(errors), title="Spray team")
		return warnings
	roster = rows if rows_sent else effective_roster(wo.custom_spray_team, rows)
	verdict = evaluate(roster, mode())
	if verdict["errors"]:
		frappe.throw("<br>".join(verdict["errors"]), title="Spray team")
	return verdict["warnings"]


def refusal_for_submit(name: str) -> str | None:
	"""Reason a stored plan cannot go for approval, or None."""
	team = frappe.db.get_value("Work Order", name, "custom_spray_team")
	rows = frappe.get_all(
		"Custom Spray Plan Team Member", filters={"parent": name, "parenttype": "Work Order"},
		fields=["employee", "role"], order_by="idx",
	)
	if not team and not rows:
		errors, _ = no_team_verdict(team_mode())
		return " ".join(errors) or None
	verdict = evaluate(effective_roster(team, rows), mode())
	return " ".join(verdict["errors"]) or None


@frappe.whitelist()
def check_spray_team(team: str | None = None, members=None) -> dict:
	"""Live check for the planner form. ``members`` is ``[{employee, role}]`` (JSON ok).

	Returns ``{mode, ok, errors, warnings, supervisors:[{employee, employee_name, status,
	message}]}``; status is ok / missing_role / no_user."""
	if frappe.session.user == "Guest":
		frappe.throw("Login required.", frappe.PermissionError)
	if isinstance(members, str):
		members = frappe.parse_json(members)
	roster = effective_roster(team, members or [])
	if not team and not roster:
		errors, warnings = no_team_verdict(team_mode())
		return {"mode": mode(), "team_mode": team_mode(), "ok": not errors, "errors": errors,
			"warnings": warnings, "supervisors": []}
	verdict = evaluate(roster, mode(), lookup=supervisor_status)
	verdict["team_mode"] = team_mode()
	# The form always wants the per-name status, even when the setting is Off.
	if verdict["mode"] == CA.OFF:
		verdict["supervisors"] = [
			supervisor_status(m["employee"]) for m in roster
			if (m.get("role") or "").strip() == "Supervisor" and (m.get("employee") or "").strip()
		]
	verdict["ok"] = not verdict["errors"]
	return verdict
