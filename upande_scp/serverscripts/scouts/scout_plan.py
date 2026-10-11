"""The weekly scout plan: which scout walks which greenhouse on which day (spec
2026-10-11-schedule-crew-availability-and-scout-plan-design, C3–C7).

Two endpoints feed the Schedule page's *Scout plan* view:

* ``get_scout_plan(crop, farm, week_start)`` — the farm's houses, its scouts, the
  week's assignments with Planned / Done / Missed, unplanned scouting, the scouts'
  leave, their assignments on other farms, and the weekly check.
* ``save_scout_plan(crop, farm, week_start, assignments)`` — replaces the farm's week.
  Refuses a scout on approved leave, a house outside the farm, or a farm outside the
  user's scope.

**Who may.** SCP General Manager, System Manager and SCP Scouting User edit, on the
farms ``scouts.api.farm_scope`` gives them; SCP Spray Plan Creator / Approver / Spray
Supervisor read (the Schedule page's other roles).

**Actuals add no scan.** Who scouted which house each day comes from the quality
aggregate's per-date partials (``_quality.day_partials``), read with the same scope
as the Scouts page's farm view — the ones ``prewarm_quality`` keeps warm — so a cold
date costs one indexed query and a warm one a Redis read. The same partials give the
farm's scouts (anyone who logged entries there in the last four weeks).
"""

from __future__ import annotations

import json
from datetime import timedelta
from importlib import import_module

import frappe
from frappe.utils import getdate, nowdate

from upande_scp.serverscripts.common import crew_availability as CA
from upande_scp.serverscripts.common import crop_catalog
from upande_scp.serverscripts.common import scout_plan_rules as R
from upande_scp.serverscripts.dashboard_aggregates._common import parent_filter_conditions
from upande_scp.serverscripts.scouting import scouting_metrics
from upande_scp.serverscripts.scouts.api import farm_scope

_quality = import_module("upande_scp.serverscripts.dashboard_aggregates._quality")

DOCTYPE = "Scout Assignment"
EDIT_ROLES = {"SCP General Manager", "System Manager", "SCP Scouting User", "Administrator"}
READ_ROLES = EDIT_ROLES | {"SCP Spray Plan Creator", "SCP Spray Plan Approver", "SCP Spray Supervisor"}
#: The farm's scouts are those who logged entries there in this many days before the week.
SCOUT_WINDOW_DAYS = 28


def _roles(user=None) -> set[str]:
	user = user or frappe.session.user
	if user == "Administrator":
		return {"Administrator"}
	return set(frappe.get_roles(user))


def can_edit(user=None) -> bool:
	return bool(_roles(user) & EDIT_ROLES)


def _require_read():
	if not _roles() & READ_ROLES:
		frappe.throw("You are not permitted to view the scout plan.", frappe.PermissionError)


def _require_edit():
	if not can_edit():
		frappe.throw("You are not permitted to change the scout plan.", frappe.PermissionError)


def _context(crop, farm, week_start) -> dict:
	"""Resolve crop, farm (scope-checked) and week. One farm always: the first
	visible one when none is given."""
	crop = crop_catalog.resolve_crop(crop)
	farms_map = scouting_metrics.get_farms_and_warehouses() or {}
	fs = farm_scope(crop, farm, farms_map)
	farm = fs["farm"] or (fs["farms"][0] if fs["farms"] else "")
	if not farm:
		frappe.throw("You have no farm whose scout plan you can see.", frappe.PermissionError)
	days = R.week_days(week_start or nowdate())
	return {
		"crop": crop,
		"farm": farm,
		"farms": fs["farms"],
		"farms_map": farms_map,
		"houses": list(farms_map.get(farm, [])),
		"days": days,
		"today": getdate(nowdate()),
	}


# ─────────────────────────────── actuals ─────────────────────────────────────


def actuals(crop: str, houses: list[str], from_date, to_date) -> list[dict]:
	"""``[{date, scout, greenhouse, entries}]`` between two dates (≤ today), from the
	cached per-date partials. Only the given houses are kept."""
	start, end = R.as_date(from_date), R.as_date(to_date)
	if not houses or end < start:
		return []
	where, params = parent_filter_conditions(str(start), str(end), crop, list(houses))
	if where == "1=0":
		return []
	days = []
	d = end
	while d >= start:
		days.append(d.isoformat())
		d -= timedelta(days=1)
	parts = _quality.day_partials(where, params, days)
	wanted = set(houses)
	out = []
	for day in sorted(parts):
		fold = parts[day][0]
		for scout, s in fold.scouts.items():
			for wh, n in s.house_entries.items():
				if wh in wanted and n:
					out.append({"date": day, "scout": scout, "greenhouse": wh, "entries": int(n)})
	return out


# ─────────────────────────────── reading ─────────────────────────────────────


def _assignments(farm: str, start, end) -> list[dict]:
	return frappe.get_all(
		DOCTYPE,
		filters={"farm": farm, "date": ["between", [str(start), str(end)]]},
		fields=["name", "date", "scout", "scout_name", "greenhouse", "notes", "status"],
		order_by="date, greenhouse, scout",
		limit_page_length=0,
	)


def _elsewhere(scouts, farm: str, start, end) -> list[dict]:
	if not scouts:
		return []
	return [
		{"date": str(r["date"]), "scout": r["scout"], "farm": r["farm"]}
		for r in frappe.get_all(
			DOCTYPE,
			filters={"scout": ["in", list(scouts)], "farm": ["!=", farm],
					 "date": ["between", [str(start), str(end)]]},
			fields=["date", "scout", "farm"],
			limit_page_length=0,
		)
	]


def _leave_days(scouts, days) -> dict:
	"""scout → {date: on_leave | leave_pending} for the week's days with leave."""
	if not scouts:
		return {}
	by_emp: dict[str, list] = {}
	for lv in CA.leaves_between(scouts, days[0], days[-1]):
		by_emp.setdefault(lv["employee"], []).append(lv)
	out: dict[str, dict] = {}
	for emp, rows in by_emp.items():
		for d in days:
			st = CA.classify(d, rows)["status"]
			if st in (CA.ON_LEAVE, CA.LEAVE_PENDING):
				out.setdefault(emp, {})[str(d)] = st
	return out


def _people(ids) -> dict:
	ids = [i for i in dict.fromkeys(ids) if i]
	if not ids:
		return {}
	return {
		r["name"]: r
		for r in frappe.get_all(
			"Employee", filters={"name": ["in", ids]},
			fields=["name", "employee_name", "image", "user_id", "status"],
			limit_page_length=0,
		)
	}


def build(ctx: dict) -> dict:
	days, today, houses, farm = ctx["days"], ctx["today"], ctx["houses"], ctx["farm"]
	monday, sunday = days[0], days[-1]
	last_monday = monday - timedelta(days=7)

	# One read of the partials covers the scout window, last week and this week.
	window_end = min(sunday, today)
	window_start = min(monday, today) - timedelta(days=SCOUT_WINDOW_DAYS)
	seen = actuals(ctx["crop"], houses, window_start, window_end)

	week_actuals = [a for a in seen if str(monday) <= a["date"] <= str(sunday)]
	last_actuals = [a for a in seen if str(last_monday) <= a["date"] < str(monday)]
	rows = _assignments(farm, monday, sunday)
	last_rows = _assignments(farm, last_monday, monday - timedelta(days=1))

	entries_by_scout: dict[str, int] = {}
	for a in seen:
		entries_by_scout[a["scout"]] = entries_by_scout.get(a["scout"], 0) + a["entries"]
	scout_ids = set(entries_by_scout) | {r["scout"] for r in rows} | {r["scout"] for r in last_rows}
	people = _people(scout_ids)
	scouts = sorted(
		(
			{
				"scout": s,
				"name": (people.get(s) or {}).get("employee_name") or s,
				"image": (people.get(s) or {}).get("image") or "",
				"user": (people.get(s) or {}).get("user_id") or None,
				"entries": entries_by_scout.get(s, 0),
				"active": ((people.get(s) or {}).get("status") or "Active") == "Active",
			}
			for s in scout_ids
		),
		key=lambda r: (r["name"] or "").lower(),
	)

	done = {(a["date"], a["scout"], a["greenhouse"]) for a in week_actuals}
	leaves = _leave_days(scout_ids, days)
	away = lambda scout, d: (leaves.get(scout) or {}).get(str(d)) == CA.ON_LEAVE  # noqa: E731
	assignments = [
		{
			"name": r["name"],
			"date": str(r["date"]),
			"scout": r["scout"],
			"scoutName": r.get("scout_name") or (people.get(r["scout"]) or {}).get("employee_name") or r["scout"],
			"greenhouse": r["greenhouse"],
			"notes": r.get("notes") or "",
			"status": R.assignment_status(r["date"], today, (str(r["date"]), r["scout"], r["greenhouse"]) in done,
										  away(r["scout"], r["date"])),
		}
		for r in rows
	]
	elsewhere = _elsewhere(scout_ids, farm, monday, sunday)
	return {
		"crop": ctx["crop"],
		"farm": farm,
		"farms": ctx["farms"],
		"weekStart": str(monday),
		"weekEnd": str(sunday),
		"days": [str(d) for d in days],
		"today": str(today),
		"canEdit": can_edit(),
		"greenhouses": houses,
		"scouts": scouts,
		"assignments": assignments,
		"actuals": week_actuals,
		"unplanned": R.unplanned_actuals(week_actuals, assignments),
		"lastWeek": {
			"assignments": [{"date": str(r["date"]), "scout": r["scout"], "greenhouse": r["greenhouse"]}
							for r in last_rows],
			"actuals": last_actuals,
		},
		"leaves": leaves,
		"elsewhere": elsewhere,
		"check": R.weekly_check(houses, assignments, elsewhere, farm, leaves),
	}


@frappe.whitelist()
def get_scout_plan(crop=None, farm=None, week_start=None) -> dict:
	_require_read()
	return build(_context(crop, farm, week_start))


# ─────────────────────────────── saving ──────────────────────────────────────


def _parse(assignments) -> list[dict]:
	if isinstance(assignments, str):
		assignments = json.loads(assignments or "[]")
	out: dict[tuple, dict] = {}
	for a in assignments or []:
		row = {
			"date": str(R.as_date(a.get("date"))),
			"scout": (a.get("scout") or "").strip(),
			"greenhouse": (a.get("greenhouse") or "").strip(),
			"notes": (a.get("notes") or "").strip(),
		}
		if not (row["scout"] and row["greenhouse"]):
			frappe.throw("Each assignment needs a scout and a greenhouse.")
		out.setdefault((row["date"], row["scout"], row["greenhouse"]), row)
	return list(out.values())


@frappe.whitelist(methods=["POST"])
def save_scout_plan(crop=None, farm=None, week_start=None, assignments=None) -> dict:
	"""Replace the farm's week with ``assignments`` (a JSON list of
	``{date, scout, greenhouse, notes?}``). Returns the fresh plan plus
	``warnings`` (pending leave)."""
	_require_edit()
	if not (farm or "").strip():
		frappe.throw("Choose a farm to save its scout plan.")
	ctx = _context(crop, farm, week_start)
	days, houses = ctx["days"], set(ctx["houses"])
	week = {str(d) for d in days}
	rows = _parse(assignments)

	bad_day = sorted({r["date"] for r in rows if r["date"] not in week})
	if bad_day:
		frappe.throw(f"These dates are outside the week of {days[0]}: {', '.join(bad_day)}.")
	outside = sorted({r["greenhouse"] for r in rows if r["greenhouse"] not in houses})
	if outside:
		frappe.throw(f"Not a greenhouse of {ctx['farm']}: {', '.join(outside)}.", frappe.PermissionError)
	people = _people({r["scout"] for r in rows})
	unknown = sorted({r["scout"] for r in rows if r["scout"] not in people})
	if unknown:
		frappe.throw(f"Unknown scout(s): {', '.join(unknown)}.")

	leaves = _leave_days({r["scout"] for r in rows}, days)
	refused, warnings = [], []
	for r in rows:
		st = leaves.get(r["scout"], {}).get(r["date"])
		name = people[r["scout"]].get("employee_name") or r["scout"]
		if st == CA.ON_LEAVE:
			refused.append(f"{name} is on approved leave on {r['date']}")
		elif st == CA.LEAVE_PENDING:
			warnings.append(f"{name} has a leave application pending for {r['date']}.")
	if refused:
		frappe.throw("Scouts on approved leave cannot be planned:\n- " + "\n- ".join(sorted(set(refused))))

	today = ctx["today"]
	past = [d for d in days if d <= today]
	done = set()
	if past and rows:
		done = {(a["date"], a["scout"], a["greenhouse"])
				for a in actuals(ctx["crop"], ctx["houses"], past[0], past[-1])}

	frappe.db.delete(DOCTYPE, {"farm": ctx["farm"], "date": ["between", [str(days[0]), str(days[-1])]]})
	for r in rows:
		p = people[r["scout"]]
		frappe.get_doc({
			"doctype": DOCTYPE,
			"date": r["date"],
			"scout": r["scout"],
			"scout_name": p.get("employee_name"),
			"user": p.get("user_id"),
			"greenhouse": r["greenhouse"],
			"farm": ctx["farm"],
			"crop": ctx["crop"] or None,
			"notes": r["notes"],
			"status": R.assignment_status(r["date"], today, (r["date"], r["scout"], r["greenhouse"]) in done),
		}).insert(ignore_permissions=True)

	out = build(ctx)
	out["warnings"] = sorted(set(warnings))
	out["saved"] = len(rows)
	return out
