"""Who runs a spray, and who actually turned up — for the phone's Supervisor tab.

Two things the handset needs on the plan it downloaded, so it can act on them with no
signal:

* **The plan's supervisor(s)** (a plan has up to two). Only they — plus the people the
  server already lets confirm a tank mix: a General Manager / Stock Manager, a spray
  supervisor rostered on the farm — may scan, mix, start or end the spray. Anyone else
  opens the plan read-only. The phone compares the logged-in user against
  ``spray_supervisors``; ``can_run`` is the server's own verdict for the downloading user,
  which covers the farm-roster / manager cases the phone cannot work out alone.
* **The "tier two" team check** against Time & Attendance: each listed member's earliest
  IN punch today (``Employee Checkin``, keyed by employee and ``time``). Setting
  ``spray_checkin_check`` (Scouting and Crop Protection Settings) decides what a missing
  punch does at Start: Off = dots only, Warn = a notice, Block = cannot start until the
  absent member is removed. Blank reads as Off.

The shaping rules are pure functions so they are tested without a database.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import frappe

SETTINGS = "Scouting and Crop Protection Settings"
SETTING_FIELD = "spray_checkin_check"
OFF, WARN, BLOCK = "Off", "Warn", "Block"
_MODES = (OFF, WARN, BLOCK)


# ─────────────────────────────── pure rules ──────────────────────────────────


def normalise_mode(value) -> str:
	"""Blank or unknown reads as Off — unlike the leave check, an unset Single must not
	start refusing sprays."""
	text = (value or "").strip().title()
	return text if text in _MODES else OFF


def is_supervisor_role(role) -> bool:
	return (role or "").strip().lower() == "supervisor"


def absent_members(team: list[dict], checkins: dict) -> list[dict]:
	"""Team rows with no check-in today. ``checkins`` maps employee → time (or truthy)."""
	out = []
	for m in team:
		emp = m.get("employee") or m.get("id")
		if emp and not checkins.get(emp):
			out.append(m)
	return out


def absent_notice(names: list[str]) -> str:
	if not names:
		return ""
	if len(names) == 1:
		return (
			f"{names[0]} has no check-in recorded today in Time & Attendance. If they are "
			"not here, please remove them from the team before starting — the spray record "
			"will show everyone listed as having taken part."
		)
	return (
		f"{', '.join(names[:-1])} and {names[-1]} have no check-in recorded today in Time & "
		"Attendance. If they are not here, please remove them from the team before "
		"starting — the spray record will show everyone listed as having taken part."
	)


def block_message(names: list[str]) -> str:
	return (
		absent_notice(names)
		+ " The spray check-in setting is Block, so the spray cannot start while anyone "
		"listed has no check-in."
	)


def can_run(user: str | None, supervisor_users, override: bool = False) -> bool:
	"""The phone-side rule, mirrored here for the tests: a supervisor of the plan, or an
	override holder (manager / farm-rostered supervisor)."""
	if not user:
		return False
	return bool(override) or user in set(supervisor_users or [])


# ─────────────────────────────── database ────────────────────────────────────


def checkin_mode() -> str:
	"""The setting, read defensively: the field may not exist yet on an older schema."""
	try:
		if not frappe.get_meta(SETTINGS).has_field(SETTING_FIELD):
			return OFF
		return normalise_mode(frappe.db.get_single_value(SETTINGS, SETTING_FIELD))
	except Exception:
		return OFF


def _day(value=None) -> date:
	if isinstance(value, datetime):
		return value.date()
	if isinstance(value, date):
		return value
	if value:
		return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
	return frappe.utils.getdate(frappe.utils.today())


def checkin_times(employees, on_date=None) -> dict[str, str]:
	"""employee → ISO time of their earliest IN punch on the date. One query.

	Same definition as ``crew_availability.checked_in`` (IN punch between 00:00 and 00:00
	next day) with the time kept. Attendance is not used: on live it is created around
	midnight, so at 06:00 it says nothing.
	"""
	emps = sorted({e for e in (employees or []) if e})
	if not emps or not frappe.db.table_exists("Employee Checkin"):
		return {}
	day = _day(on_date)
	rows = frappe.db.sql(
		"""SELECT employee, MIN(`time`) FROM `tabEmployee Checkin`
		    WHERE employee IN %(emps)s AND log_type = 'IN'
		      AND `time` >= %(start)s AND `time` < %(end)s
		 GROUP BY employee""",
		{"emps": tuple(emps), "start": f"{day} 00:00:00",
		 "end": f"{day + timedelta(days=1)} 00:00:00"},
	)
	return {r[0]: r[1].isoformat(sep=" ") if hasattr(r[1], "isoformat") else str(r[1]) for r in rows}


def _team_rows_bulk(wos: list[dict]) -> dict[str, list[dict]]:
	"""Work Order name → [{employee, employee_name, role}], per-plan snapshot first, the
	linked Spray Team as the fallback. Two queries for the whole feed."""
	names = [w["name"] for w in wos]
	out: dict[str, list[dict]] = {n: [] for n in names}
	if not names:
		return out
	for r in frappe.get_all(
		"Custom Spray Plan Team Member",
		filters={"parent": ["in", names], "parenttype": "Work Order",
		         "parentfield": "custom_spray_plan_team_members"},
		fields=["parent", "employee", "employee_name", "role"],
		order_by="idx asc", limit_page_length=0,
	):
		if r.employee:
			out[r.parent].append(
				{"employee": r.employee, "employee_name": r.employee_name or "",
				 "role": (r.role or "").strip()})
	teams = {w["name"]: w.get("custom_spray_team") for w in wos if not out[w["name"]]
	         and w.get("custom_spray_team")}
	teams = {k: v for k, v in teams.items() if frappe.db.exists("Spray Team", v)}
	if teams and frappe.db.table_exists("Spray Team Details"):
		rows = frappe.db.sql(
			"""SELECT parent, name1, role FROM `tabSpray Team Details`
			    WHERE parenttype = 'Spray Team' AND parent IN %s AND IFNULL(name1, '') != ''
			 ORDER BY idx""",
			(tuple(set(teams.values())),), as_dict=True,
		)
		by_team: dict[str, list[dict]] = {}
		for r in rows:
			by_team.setdefault(r.parent, []).append(
				{"employee": r.name1, "employee_name": "", "role": (r.role or "").strip()})
		for wo_name, team in teams.items():
			out[wo_name] = list(by_team.get(team, []))
	return out


def _employee_info(employees) -> dict[str, dict]:
	emps = sorted({e for e in employees if e})
	if not emps:
		return {}
	return {
		r.name: {"employee_name": r.employee_name or r.name, "user": r.user_id or None}
		for r in frappe.get_all("Employee", filters={"name": ["in", emps]},
		                        fields=["name", "employee_name", "user_id"],
		                        limit_page_length=0)
	}


def _override_context(user: str, wos: list[dict]):
	"""What lets ``user`` run any plan regardless of the supervisor list: a manager role
	(whole site) or the farms they are rostered on as a spray supervisor."""
	from upande_scp.serverscripts.spray_plan_creator.spray_session import MANUFACTURE_OVERRIDE_ROLES

	if user == "Administrator" or set(frappe.get_roles(user)) & set(MANUFACTURE_OVERRIDE_ROLES):
		return True, set(), {}
	farms = set(frappe.get_all(
		"Farm Spray Supervisor",
		filters={"parenttype": "Farm", "parentfield": "spray_supervisors", "user": user},
		pluck="parent", limit_page_length=0))
	ghs = sorted({w.get("custom_greenhouse") for w in wos if w.get("custom_greenhouse")})
	gh_farm = {}
	if farms and ghs:
		gh_farm = {r.name: r.custom_farm for r in frappe.get_all(
			"Warehouse", filters={"name": ["in", ghs]}, fields=["name", "custom_farm"],
			limit_page_length=0)}
	return False, farms, gh_farm


def attach_to_plans(work_orders: list[dict], on_date=None, user: str | None = None) -> None:
	"""Add the supervision fields to the plans of the download feed, in place.

	Fields (all additive; an older phone ignores them):

	* ``spray_supervisors`` — ``[{employee, employee_name, user}]``, at most two.
	* ``team_roster`` — the server's team: ``[{id, name, role, user, checked_in,
	  checkin_time}]``. Kept apart from ``spray_team_members`` on purpose: that one carries
	  the supervisor's own offline edits, and a re-download must not overwrite them.
	* ``checkin_day`` / ``checkin_fetched_at`` — which day the punches are for and when they
	  were read, so the phone can tell a stale cache from today's data.
	* ``spray_checkin_check`` — Off / Warn / Block.
	* ``can_run`` / ``can_run_user`` — the server's verdict for the downloading user.
	"""
	if not work_orders:
		return
	user = user or frappe.session.user
	day = _day(on_date)
	rosters = _team_rows_bulk(work_orders)
	info = _employee_info(r["employee"] for rows in rosters.values() for r in rows)
	punches = checkin_times(info.keys(), day)
	mode = checkin_mode()
	override, farms, gh_farm = _override_context(user, work_orders)
	now = frappe.utils.now_datetime().isoformat(sep=" ")

	for wo in work_orders:
		rows = rosters.get(wo["name"], [])
		sups = []
		for r in rows:
			if is_supervisor_role(r["role"]):
				i = info.get(r["employee"], {})
				sups.append({"employee": r["employee"],
				             "employee_name": r["employee_name"] or i.get("employee_name") or r["employee"],
				             "user": i.get("user")})
		wo["spray_supervisors"] = sups[:2]
		wo["team_roster"] = [{
			"id": r["employee"],
			"name": r["employee_name"] or info.get(r["employee"], {}).get("employee_name") or r["employee"],
			"role": r["role"],
			"user": info.get(r["employee"], {}).get("user"),
			"checked_in": r["employee"] in punches,
			"checkin_time": punches.get(r["employee"]),
		} for r in rows]
		wo["checkin_day"] = str(day)
		wo["checkin_fetched_at"] = now
		wo["spray_checkin_check"] = mode
		farm_ok = bool(farms) and gh_farm.get(wo.get("custom_greenhouse")) in farms
		wo["can_run"] = bool(override or farm_ok or user in {s["user"] for s in sups if s["user"]})
		wo["can_run_user"] = user


def supervision_for(work_order: str, on_date=None) -> dict:
	"""The same fields for one plan — what the phone calls online to refresh them."""
	if not frappe.db.exists("Work Order", work_order):
		frappe.throw(f"Work Order {work_order} not found.")
	row = frappe.db.get_value(
		"Work Order", work_order, ["name", "custom_greenhouse", "custom_spray_team"], as_dict=True)
	attach_to_plans([row], on_date)
	return dict(row)


# ─────────────────────────────── enforcement ─────────────────────────────────


def absent_for_plan(wo, on_date=None) -> list[str]:
	"""Display names of the plan's listed members with no check-in on the date."""
	team = [{"employee": r.employee, "employee_name": r.employee_name or ""}
	        for r in (getattr(wo, "custom_spray_plan_team_members", None) or [])
	        if getattr(r, "employee", None)]
	if not team:
		return []
	punches = checkin_times([m["employee"] for m in team], on_date)
	return [m["employee_name"] or m["employee"] for m in absent_members(team, punches)]


def assert_start_allowed(wo, on_date=None, can_block: bool = True) -> list[str]:
	"""Block mode: refuse the start while any listed member has no check-in today.

	Returns the notice sentences for Warn mode (and for Block when ``can_block`` is false —
	an offline replay is recorded, never refused). Off returns nothing and runs no query.
	"""
	mode = checkin_mode()
	if mode == OFF:
		return []
	names = absent_for_plan(wo, on_date)
	if not names:
		return []
	if mode == BLOCK and can_block:
		frappe.throw(block_message(names), title="Team not checked in")
	return [absent_notice(names)]


@frappe.whitelist()
def get_spray_supervision(work_order: str, on_date=None) -> dict:
	"""Supervisors, team with today's check-ins, the setting and the caller's ``can_run``
	for one plan. Read-only; refreshed by the phone whenever it is online."""
	if not work_order:
		frappe.throw("work_order is required.")
	if not frappe.has_permission("Work Order", "read", work_order):
		frappe.throw(f"Not permitted to read {work_order}.", frappe.PermissionError)
	out = supervision_for(work_order, on_date)
	return {k: out.get(k) for k in (
		"spray_supervisors", "team_roster", "checkin_day", "checkin_fetched_at",
		"spray_checkin_check", "can_run", "can_run_user")}
