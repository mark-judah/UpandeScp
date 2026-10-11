"""The sprayer register: who handles spray chemicals, and their exposure totals.

`sync_sprayers` builds the register from the three places a sprayer shows up
(spec S2):

    Spray Team Details.name1                      — rostered on a team
    Spray Application Logsheet applicators /
      persons_mixing_1/2 / supervisor_name        — named on a submitted logsheet
    Employee.designation ∈ SPRAYER_DESIGNATIONS   — hired as one (active only)

It is idempotent and never deletes: an Employee who leaves goes Inactive, a
member removed from a team keeps their Sprayer with the team cleared.

Farm, in order: the spray team's farm → Employee.custom_farm → the farm of
their latest logsheet. Role: the team role → what they did on logsheets →
their designation.

`recompute_totals` rolls Sprayer Exposure up onto each Sprayer — after every
logsheet write and nightly, so the 30-day window moves forward.
"""

from __future__ import annotations

import frappe
from frappe.utils import add_days, getdate, nowdate

SPRAYER_DESIGNATIONS = {
	"Spray Applicator": "Sprayer",
	"Sprayer": "Sprayer",
	"Spray Supervisor": "Supervisor",
	"Spray Pump Operator": "Pump Operator",
}

RUN_ROLES = ("System Manager", "SCP General Manager")
SAL = "Spray Application Logsheet"


def _employee_farm_column() -> bool:
	return frappe.db.has_column("Employee", "custom_farm")


def _team_rows(employees=None):
	"""[(employee, role, team, team_farm, enabled)] — enabled teams first."""
	cond, params = "", {}
	if employees is not None:
		cond = "AND d.name1 IN %(emps)s"
		params["emps"] = tuple(employees) or ("",)
	return frappe.db.sql(
		f"""SELECT d.name1 AS employee, d.role, t.name AS team,
		           t.custom_farm AS farm, t.enabled
		      FROM `tabSpray Team Details` d
		      JOIN `tabSpray Team` t ON t.name = d.parent
		     WHERE d.parenttype = 'Spray Team' AND IFNULL(d.name1, '') != '' {cond}
		     ORDER BY t.enabled DESC, t.name, d.idx""",
		params,
		as_dict=True,
	)


def _logsheet_roles(employees=None):
	"""{employee: {"role", "farm"}} from submitted logsheets — latest farm wins."""
	cond, params = "", {}
	if employees is not None:
		cond = "AND x.employee IN %(emps)s"
		params["emps"] = tuple(employees) or ("",)
	rows = frappe.db.sql(
		f"""SELECT x.employee, x.role, s.farm, s.date
		      FROM (
		        SELECT a.parent AS sal, a.applicator_name AS employee, 'Sprayer' AS role
		          FROM `tabSpray Application Applicator` a
		         WHERE a.parenttype = %(sal)s
		        UNION ALL SELECT name, persons_mixing_1, 'Mixer' FROM `tab{SAL}` WHERE docstatus = 1
		        UNION ALL SELECT name, persons_mixing_2, 'Mixer' FROM `tab{SAL}` WHERE docstatus = 1
		        UNION ALL SELECT name, supervisor_name, 'Supervisor' FROM `tab{SAL}` WHERE docstatus = 1
		      ) x
		      JOIN `tab{SAL}` s ON s.name = x.sal AND s.docstatus = 1
		     WHERE IFNULL(x.employee, '') != '' {cond}
		     ORDER BY s.date, s.name""",
		{"sal": SAL, **params},
		as_dict=True,
	)
	order = ("Sprayer", "Pump Operator", "Mixer", "Supervisor")
	out: dict = {}
	for r in rows:
		cur = out.setdefault(r.employee, {"role": r.role, "farm": None})
		if order.index(r.role) < order.index(cur["role"]):
			cur["role"] = r.role
		if r.farm:
			cur["farm"] = r.farm  # rows are date-ordered: the last one is the latest
	return out


def _designated(employees=None):
	cond, params = "", {"des": tuple(SPRAYER_DESIGNATIONS)}
	if employees is not None:
		cond = "AND name IN %(emps)s"
		params["emps"] = tuple(employees) or ("",)
	return frappe.db.sql(
		f"""SELECT name, designation FROM `tabEmployee`
		     WHERE status = 'Active' AND designation IN %(des)s {cond}""",
		params,
		as_dict=True,
	)


def desired_register(employees=None) -> dict:
	"""{employee: {role, farm, spray_team, status}} — what the register should say."""
	want: dict = {}

	team_of: dict = {}
	for r in _team_rows(employees):
		team_of.setdefault(r.employee, r)
	logs = _logsheet_roles(employees)
	designated = {r.name: SPRAYER_DESIGNATIONS[r.designation] for r in _designated(employees)}

	emps = set(team_of) | set(logs) | set(designated)
	if not emps:
		return want

	fields = ["name", "status"] + (["custom_farm"] if _employee_farm_column() else [])
	info = {
		e.name: e
		for e in frappe.get_all("Employee", filters={"name": ["in", list(emps)]}, fields=fields)
	}
	for emp in emps:
		if emp not in info:
			continue  # a team row pointing at a deleted Employee
		team = team_of.get(emp)
		log = logs.get(emp) or {}
		role = (
			(team.role if team and team.role else None)
			or log.get("role")
			or designated.get(emp)
			or "Sprayer"
		)
		farm = (
			(team.farm if team else None)
			or info[emp].get("custom_farm")
			or log.get("farm")
		)
		want[emp] = {
			"role": role,
			"farm": farm,
			"spray_team": team.team if team else None,
			"status": "Active" if info[emp].status == "Active" else "Inactive",
		}
	return want


def sync_sprayers(employees=None) -> dict:
	"""Create / update Sprayers. ``employees`` narrows the run to those people.

	Never deletes. A narrowed run also clears the team of anyone in the list
	who is no longer on one (they were just removed from a team).
	"""
	if employees is not None:
		employees = sorted({e for e in employees if e})
		if not employees:
			return {"created": 0, "updated": 0, "total": 0}

	want = desired_register(employees)
	have_filters = {"employee": ["in", employees]} if employees is not None else {}
	have = {
		r.employee: r
		for r in frappe.get_all(
			"Sprayer",
			filters=have_filters,
			fields=["name", "employee", "role", "farm", "spray_team", "status"],
		)
	}

	created = updated = 0
	for emp, w in sorted(want.items()):
		cur = have.get(emp)
		if cur is None:
			doc = frappe.get_doc({"doctype": "Sprayer", "employee": emp, **w})
			doc.insert(ignore_permissions=True)
			created += 1
			continue
		diff = {k: v for k, v in w.items() if (cur.get(k) or None) != (v or None)}
		if diff:
			doc = frappe.get_doc("Sprayer", cur.name)
			doc.update(diff)
			doc.save(ignore_permissions=True)
			updated += 1

	# Off every team and no longer on any source list: keep, clear the team.
	for emp, cur in have.items():
		if emp in want:
			continue
		fix = {}
		if cur.spray_team:
			fix["spray_team"] = None
		status = frappe.db.get_value("Employee", emp, "status")
		if status and status != "Active" and cur.status != "Inactive":
			fix["status"] = "Inactive"
		if fix:
			frappe.db.set_value("Sprayer", cur.name, fix)
			updated += 1

	return {"created": created, "updated": updated, "total": len(want)}


def sprayer_map(employees) -> dict:
	"""{employee: Sprayer name} for these employees."""
	employees = [e for e in employees if e]
	if not employees:
		return {}
	return {
		r.employee: r.name
		for r in frappe.get_all(
			"Sprayer", filters={"employee": ["in", employees]}, fields=["name", "employee"]
		)
	}


def recompute_totals(sprayers=None) -> int:
	"""Roll Sprayer Exposure up onto each Sprayer. Returns how many were written."""
	cutoff = add_days(getdate(nowdate()), -30)
	cond, params = "", {"cutoff": cutoff, "today": getdate(nowdate())}
	if sprayers is not None:
		sprayers = [s for s in sprayers if s]
		if not sprayers:
			return 0
		cond = "WHERE sp.name IN %(sprayers)s"
		params["sprayers"] = tuple(sprayers)
	rows = frappe.db.sql(
		f"""SELECT sp.name,
		           COALESCE(SUM(CASE WHEN e.date >= %(cutoff)s AND e.date <= %(today)s THEN e.hours END), 0) AS hours_30d,
		           COALESCE(SUM(CASE WHEN e.date >= %(cutoff)s AND e.date <= %(today)s THEN e.weighted_hours END), 0) AS weighted_30d,
		           COALESCE(SUM(e.hours), 0) AS hours_total,
		           COALESCE(SUM(e.weighted_hours), 0) AS weighted_total,
		           MAX(e.date) AS last_exposure,
		           sp.hours_30d AS o_h30, sp.weighted_30d AS o_w30,
		           sp.hours_total AS o_ht, sp.weighted_total AS o_wt,
		           sp.last_exposure AS o_last
		      FROM `tabSprayer` sp
		      LEFT JOIN `tabSprayer Exposure` e ON e.sprayer = sp.name
		      {cond}
		     GROUP BY sp.name""",
		params,
		as_dict=True,
	)
	written = 0
	for r in rows:
		new = {
			"hours_30d": round(float(r.hours_30d), 4),
			"weighted_30d": round(float(r.weighted_30d), 4),
			"hours_total": round(float(r.hours_total), 4),
			"weighted_total": round(float(r.weighted_total), 4),
			"last_exposure": r.last_exposure,
		}
		old = {
			"hours_30d": round(float(r.o_h30 or 0), 4),
			"weighted_30d": round(float(r.o_w30 or 0), 4),
			"hours_total": round(float(r.o_ht or 0), 4),
			"weighted_total": round(float(r.o_wt or 0), 4),
			"last_exposure": r.o_last,
		}
		if new != old:
			frappe.db.set_value("Sprayer", r.name, new, update_modified=False)
			written += 1
	return written


# ───────────────────────────── entry points ──────────────────────────────


def daily():
	"""Scheduler: refresh the register, then roll the 30-day window forward."""
	from upande_scp.serverscripts.sprayers import exposure

	sync_sprayers()
	exposure.rebuild_missing()
	recompute_totals()


def on_spray_team_update(doc, method=None):
	"""Spray Team saved: re-sync everyone on it now, and everyone just taken off."""
	before = doc.get_doc_before_save()
	members = {r.name1 for r in doc.get("team") or [] if r.name1}
	if before:
		members |= {r.name1 for r in before.get("team") or [] if r.name1}
	if members:
		try:
			sync_sprayers(sorted(members))
		except Exception:
			# The team save matters more; the nightly sync catches up.
			frappe.log_error(title=f"Sprayer sync on team save: {doc.name}")


@frappe.whitelist()
def sync_sprayers_now():
	"""Desk button on the Sprayer list."""
	if not set(RUN_ROLES) & set(frappe.get_roles()) and frappe.session.user != "Administrator":
		frappe.throw("Only a General Manager can sync the sprayer register.", frappe.PermissionError)
	result = sync_sprayers()
	result["totals_written"] = recompute_totals()
	return result
