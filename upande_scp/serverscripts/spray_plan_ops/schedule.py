"""The spray Schedule: plans with their crews, and the crews' leave, over a date range.

One endpoint, ``get_schedule``, feeds both views on the Schedule page (calendar and
Gantt). Plans are Application Floor Plan Work Orders; a plan's crew is its
``custom_spray_plan_team_members``; leave is HRMS ``Leave Application`` (approved, and
open as "pending"). Scoped by ``crop_scope`` — only greenhouses on farms the user may
see, narrowed to the crop's farms.

A plan's *team* is ``custom_spray_team`` when that names a Spray Team. After the
morning confirmation it holds the crew as text instead ("Name - Role" lines), so the
team is then inferred from the master Spray Team that shares most of the crew.
"""

from __future__ import annotations

from datetime import date, timedelta

import frappe
from frappe.utils import add_days, getdate

from upande_scp.serverscripts.common import crop_scope
from upande_scp.serverscripts.common import crew_availability as CA

AFP_TYPE = "Application Floor Plan"
SCHEDULE_ROLES = {
	"SCP Spray Plan Creator",
	"SCP Spray Plan Approver",
	"SCP Spray Supervisor",
	"SCP General Manager",
	"System Manager",
	"Administrator",
}
NO_TEAM = "No team"
#: Longer ranges are clamped (from_date pulled up to to_date − this) and flagged.
MAX_RANGE_DAYS = 93


def _require_role() -> None:
	if frappe.session.user == "Administrator":
		return
	if not SCHEDULE_ROLES & set(frappe.get_roles()):
		frappe.throw("You are not permitted to view the spray schedule.", frappe.PermissionError)


def _greenhouses(crop: str | None, farm: str | None) -> tuple[dict[str, str], list[str]]:
	"""(greenhouse → farm, farms offered) under the user's scope."""
	farms = crop_scope.visible_farms(None, crop or None)
	offered = sorted(farms) if farms is not None else sorted(frappe.get_all("Farm", pluck="name"))
	if farm:
		if farms is not None and farm not in farms:
			return {}, offered
		wanted = [farm]
	else:
		wanted = offered
	if not wanted:
		return {}, offered
	rows = frappe.get_all(
		"Warehouse", filters={"custom_farm": ["in", wanted]}, fields=["name", "custom_farm"]
	)
	return {r["name"]: r["custom_farm"] for r in rows}, offered


def _team_index() -> tuple[set[str], dict[str, set[str]]]:
	"""(Spray Team names, employee → teams they sit on in the master list)."""
	names = set(frappe.get_all("Spray Team", pluck="name"))
	members: dict[str, set[str]] = {}
	for row in frappe.get_all(
		"Spray Team Details",
		filters={"parenttype": "Spray Team"},
		fields=["parent", "name1"],
	):
		if row.get("name1"):
			members.setdefault(row["name1"], set()).add(row["parent"])
	return names, members


def resolve_team(stored: str | None, crew: list[str], names: set[str], members: dict[str, set[str]]) -> str:
	"""The Spray Team a plan belongs to. Pure given the indexes."""
	text = (stored or "").strip()
	if text in names:
		return text
	votes: dict[str, int] = {}
	for emp in crew:
		for team in members.get(emp, ()):
			votes[team] = votes.get(team, 0) + 1
	if votes:
		return sorted(votes.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
	return NO_TEAM


def _as_day(value) -> date | None:
	return getdate(value) if value else None


@frappe.whitelist()
def get_schedule(
	crop: str | None = None,
	farm: str | None = None,
	from_date: str | None = None,
	to_date: str | None = None,
	team: str | None = None,
	state: str | None = None,
) -> dict:
	_require_role()
	crop_scope.assert_crop(crop)

	today = getdate()
	start = getdate(from_date) if from_date else today.replace(day=1)
	end = getdate(to_date) if to_date else getdate(add_days(start.replace(day=28), 4)).replace(day=1) - timedelta(days=1)
	if end < start:
		start, end = end, start
	# Capped like the quality aggregate: from_date is pulled up to to_date − 93 days and
	# the page told (``clamped``), rather than refusing or reading an unbounded span.
	clamped = (end - start).days > MAX_RANGE_DAYS
	if clamped:
		start = end - timedelta(days=MAX_RANGE_DAYS)

	houses, offered_farms = _greenhouses(crop, farm)
	payload = {
		"from_date": str(start),
		"to_date": str(end),
		"clamped": clamped,
		"range": {"from_date": str(start), "to_date": str(end)},
		"max_range_days": MAX_RANGE_DAYS,
		"crop": crop,
		"farms": offered_farms,
		"teams": [],
		"states": [],
		"plans": [],
		"leaves": [],
		"latest_plan_date": None,
		"leave_check": CA.settings()["mode"],
	}
	if not houses:
		return payload

	gh = tuple(houses)
	state_sql = "AND wo.workflow_state = %(state)s" if state else ""
	params = {"gh": gh, "start": str(start), "end_excl": str(end + timedelta(days=1)), "state": state, "afp": AFP_TYPE}
	plans = frappe.db.sql(
		f"""SELECT wo.name, wo.custom_greenhouse AS greenhouse, wo.custom_spray_team AS spray_team,
		           wo.workflow_state, wo.planned_start_date, wo.actual_start_date, wo.actual_end_date,
		           wo.custom_spray_type AS spray_type, wo.docstatus
		      FROM `tabWork Order` wo
		     WHERE wo.custom_type = %(afp)s AND wo.docstatus < 2
		       AND wo.custom_greenhouse IN %(gh)s
		       AND wo.planned_start_date < %(end_excl)s
		       AND COALESCE(wo.actual_end_date, wo.planned_start_date) >= %(start)s
		       {state_sql}
		  ORDER BY wo.planned_start_date, wo.custom_greenhouse""",
		params,
		as_dict=True,
	)
	latest = frappe.db.sql(
		f"""SELECT MAX(wo.planned_start_date) FROM `tabWork Order` wo
		     WHERE wo.custom_type = %(afp)s AND wo.docstatus < 2
		       AND wo.custom_greenhouse IN %(gh)s {state_sql}""",
		params,
	)
	payload["latest_plan_date"] = str(getdate(latest[0][0])) if latest and latest[0][0] else None

	names = [p["name"] for p in plans]
	crew_by_plan: dict[str, list[dict]] = {}
	if names:
		for row in frappe.get_all(
			"Custom Spray Plan Team Member",
			filters={"parent": ["in", names], "parenttype": "Work Order",
					 "parentfield": "custom_spray_plan_team_members"},
			fields=["parent", "employee", "employee_name", "role", "idx"],
			order_by="parent, idx",
		):
			if row.get("employee"):
				crew_by_plan.setdefault(row["parent"], []).append(row)

	team_names, team_members = _team_index()
	everyone = sorted({m["employee"] for crew in crew_by_plan.values() for m in crew})
	emp_rows = frappe.get_all("Employee", filters={"name": ["in", everyone or [""]]},
							  fields=["name", "employee_name", "image"])
	emp_names = {r["name"]: r.get("employee_name") or r["name"] for r in emp_rows}
	emp_images = {r["name"]: r.get("image") or "" for r in emp_rows}
	# "Today" rules (C2): a check-in only counts on the day itself, so it is read
	# only for the crews of today's plans, and only when the setting asks for it.
	require_checkin = CA.settings()["require_checkin"]
	today_crew = {
		m["employee"]
		for p in plans if _as_day(p["planned_start_date"]) == today
		for m in crew_by_plan.get(p["name"], [])
	}
	punched_today = CA.checked_in(today_crew, today) if (require_checkin and today_crew) else set()
	leaves = CA.leaves_between(everyone, start, end) if everyone else []
	leaves_by_emp: dict[str, list[dict]] = {}
	for lv in leaves:
		leaves_by_emp.setdefault(lv["employee"], []).append(lv)

	out_plans: list[dict] = []
	emp_teams: dict[str, set[str]] = {}
	all_teams: set[str] = set()
	for p in plans:
		crew = crew_by_plan.get(p["name"], [])
		team_name = resolve_team(p.get("spray_team"), [m["employee"] for m in crew], team_names, team_members)
		# Before the team filter: the page's team options must not shrink to the one
		# team picked, or there is nothing else to pick.
		all_teams.add(team_name)
		if team and team_name != team:
			continue
		day = _as_day(p["planned_start_date"])
		members = []
		availability = []
		on_leave = pending = 0
		for m in crew:
			is_today = day == today
			st = CA.classify(
				day, leaves_by_emp.get(m["employee"], []),
				checked_in=m["employee"] in punched_today,
				require_checkin=require_checkin and is_today,
			)
			on_leave += st["status"] == CA.ON_LEAVE
			pending += st["status"] == CA.LEAVE_PENDING
			emp_teams.setdefault(m["employee"], set()).add(team_name)
			members.append({
				"employee": m["employee"],
				"employee_name": m.get("employee_name") or emp_names.get(m["employee"]) or m["employee"],
				"role": m.get("role") or "",
				"status": st["status"],
				"half_day": st["half_day"],
			})
			availability.append({
				"employee": m["employee"],
				"name": members[-1]["employee_name"],
				"image": emp_images.get(m["employee"], ""),
				"role": members[-1]["role"],
				"status": st["status"],
			})
		out_plans.append({
			"name": p["name"],
			"greenhouse": p["greenhouse"],
			"farm": houses.get(p["greenhouse"]),
			"team": team_name,
			"workflow_state": p.get("workflow_state") or ("Draft" if not p.get("docstatus") else ""),
			"spray_type": p.get("spray_type"),
			"planned_start": str(p["planned_start_date"]) if p.get("planned_start_date") else None,
			"actual_start": str(p["actual_start_date"]) if p.get("actual_start_date") else None,
			"actual_end": str(p["actual_end_date"]) if p.get("actual_end_date") else None,
			"start": str(day) if day else None,
			"end": str(_as_day(p.get("actual_end_date")) or day) if day else None,
			"crew": members,
			"on_leave_count": on_leave,
			"pending_count": pending,
			# C2: the crew as the popover shows it — photo, name, role, status.
			"crewAvailability": availability,
			"available_count": sum(1 for a in availability if a["status"] == CA.OK),
		})

	payload["plans"] = out_plans
	payload["teams"] = sorted(all_teams)
	payload["states"] = sorted({p["workflow_state"] for p in out_plans if p["workflow_state"]})
	shown = set(emp_teams)
	payload["leaves"] = [
		{
			"name": lv["name"],
			"employee": lv["employee"],
			"employee_name": lv.get("employee_name") or emp_names.get(lv["employee"]) or lv["employee"],
			"leave_type": lv.get("leave_type"),
			"from_date": str(lv["from_date"]),
			"to_date": str(lv["to_date"]),
			"half_day": bool(int(lv.get("half_day") or 0)),
			"status": "approved" if int(lv.get("docstatus") or 0) == 1 else "pending",
			"teams": sorted(emp_teams.get(lv["employee"], set())),
		}
		for lv in leaves
		if lv["employee"] in shown
	]
	return payload
