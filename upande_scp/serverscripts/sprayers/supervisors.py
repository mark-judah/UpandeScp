"""Spray supervisor accountability: who was meant to run a spray, who did.

Two views of the same fact.

``accountability(plans)`` answers, for specific plans: the supervisor(s) on the
plan's team (``custom_spray_plan_team_members`` rows with role Supervisor) and
whoever actually scanned a chemical at the CSU or started spraying (a Work Order
Chemical Scan's ``scanned_by``, a Sprayer Movement Session's employee), or that
nobody did. The lifecycle, the Chemical Progress page and the progress email
show both, so a missed spray names the person assigned and the person who acted.

``get_supervisors`` ranks supervisors over a date range (Personnel ▸
Supervisors). A plan belongs to its day (the scheduled application time) and to
each supervisor on its team. Each plan that was due by now ends in exactly one
of four outcomes:

* on time: spraying started no later than ``GRACE_HOURS`` after the planned time
  (an early start counts);
* late: started more than that after, but on the planned day;
* missed: started on a later day;
* never started: not started and its day has passed.

A plan still ahead of its time, and a stopped plan, are not counted as due.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import frappe
from frappe.utils import get_datetime, getdate, now_datetime

from upande_scp.serverscripts.sprayers import api as personnel_api

AFP = "Application Floor Plan"
GRACE_HOURS = 2
SUPERVISOR_ROLE_WORD = "Supervisor"
OUTCOMES = ("on_time", "late", "missed", "never_started")


def _chunks(seq, n=1000):
    seq = list(seq)
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def _names(employees) -> dict:
    ids = [e for e in set(employees) if e]
    out: dict = {}
    for c in _chunks(ids):
        out.update(dict(frappe.get_all(
            "Employee", filters={"name": ["in", c]}, fields=["name", "employee_name"], as_list=True,
            limit_page_length=0,
        )))
    return out


def _supervisors_by_plan(plans) -> dict:
    out: dict = {}
    for c in _chunks(plans):
        for parent, emp in frappe.db.sql(
            """SELECT parent, employee FROM `tabCustom Spray Plan Team Member`
                WHERE parenttype = 'Work Order' AND parent IN %s AND role = %s AND IFNULL(employee, '') != ''""",
            (tuple(c), SUPERVISOR_ROLE_WORD),
        ):
            out.setdefault(parent, []).append(emp)
    return out


def _scanners_by_plan(plans) -> dict:
    """plan -> {employee: first time}, from CSU scans and spray sessions."""
    out: dict = {}
    for c in _chunks(plans):
        for parent, emp, at in frappe.db.sql(
            """SELECT parent, scanned_by, scanned_at FROM `tabWork Order Chemical Scan`
                WHERE parenttype = 'Work Order' AND parent IN %s AND IFNULL(scanned_by, '') != ''""",
            (tuple(c),),
        ):
            d = out.setdefault(parent, {})
            if emp not in d or (at and (d[emp] is None or at < d[emp])):
                d[emp] = at
        for wo, emp, at in frappe.db.sql(
            """SELECT work_order, employee, started_at FROM `tabSprayer Movement Session`
                WHERE work_order IN %s AND IFNULL(employee, '') != '' AND IFNULL(status, '') != 'Aborted'""",
            (tuple(c),),
        ):
            d = out.setdefault(wo, {})
            if emp not in d or (at and (d[emp] is None or at < d[emp])):
                d[emp] = at
    return out


def accountability(plans) -> dict:
    """``{plan: {"supervisors": [...], "scanners": [...], "nobody_scanned": bool}}``.

    Each person is ``{"employee", "name"}``; scanners add ``"at"``. The two lists
    can name the same person, or different ones, which is the point.
    """
    plans = [p for p in dict.fromkeys(plans) if p]
    if not plans:
        return {}
    sup = _supervisors_by_plan(plans)
    scan = _scanners_by_plan(plans)
    names = _names([e for v in sup.values() for e in v] + [e for v in scan.values() for e in v])
    out = {}
    for p in plans:
        who = [{"employee": e, "name": names.get(e) or e} for e in dict.fromkeys(sup.get(p, []))]
        acted = [
            {"employee": e, "name": names.get(e) or e, "at": str(at) if at else None}
            for e, at in sorted(scan.get(p, {}).items(), key=lambda kv: (kv[1] is None, str(kv[1])))
        ]
        out[p] = {"supervisors": who, "scanners": acted, "nobody_scanned": not acted}
    return out


def describe(acc) -> str:
    """One line for a table cell or an email: ``Supervisor A; scanned by B``."""
    sup = ", ".join(s["name"] for s in acc["supervisors"]) or "no supervisor on the team"
    scan = "nobody scanned" if acc["nobody_scanned"] else "scanned by " + ", ".join(s["name"] for s in acc["scanners"])
    return f"{sup}; {scan}"


# ── the KPI ─────────────────────────────────────────────────────────────────


def classify(scheduled, start, now, *, stopped=False, grace_hours=GRACE_HOURS) -> str | None:
    """A plan's outcome, or None when it is not due (stopped, unscheduled or still
    ahead). Pure."""
    if stopped or not scheduled:
        return None
    scheduled = get_datetime(scheduled)
    now = get_datetime(now)
    if start:
        start = get_datetime(start)
        if start <= scheduled + timedelta(hours=grace_hours):
            return "on_time"
        return "late" if start.date() == scheduled.date() else "missed"
    if scheduled.date() < now.date():
        return "never_started"
    return None


def rank(rows) -> list:
    """Rank by on-time share of the plans due, then by plans due. Pure.

    A supervisor with nothing due is listed after the ranked ones with no rank.
    """
    ranked = sorted((r for r in rows if r["due"]), key=lambda r: (-r["on_time_pct"], -r["due"], r["name"]))
    rest = sorted((r for r in rows if not r["due"]), key=lambda r: r["name"])
    for i, r in enumerate(ranked, 1):
        r["rank"] = i
    for r in rest:
        r["rank"] = None
    return ranked + rest


def build_rows(plans, sup, scan, now, names) -> list:
    """One row per supervisor. Pure given its inputs.

    ``plans``: dicts name, scheduled, start, completed, stopped. ``sup``: plan ->
    supervisor employees. ``scan``: plan -> {employee: time}.
    """
    rows: dict = {}

    def row(emp):
        return rows.setdefault(emp, {
            "employee": emp, "name": names.get(emp) or emp, "assigned": 0, "acted": 0, "by_other": 0,
            "nobody": 0, "completed": 0, "due": 0, "on_time": 0, "late": 0, "missed": 0,
            "never_started": 0, "covered_for_others": 0,
        })

    for p in plans:
        sups = list(dict.fromkeys(sup.get(p["name"], [])))
        actors = scan.get(p["name"], {})
        outcome = classify(p["scheduled"], p["start"], now, stopped=p["stopped"])
        for e in sups:
            r = row(e)
            r["assigned"] += 1
            if e in actors:
                r["acted"] += 1
            elif actors:
                r["by_other"] += 1
            else:
                r["nobody"] += 1
            if p["completed"]:
                r["completed"] += 1
            if outcome:
                r["due"] += 1
                r[outcome] += 1
        for e in actors:
            if e not in sups:
                row(e)["covered_for_others"] += 1
    out = []
    for r in rows.values():
        if not r["assigned"] and not r["covered_for_others"]:
            continue
        r["on_time_pct"] = round(100 * r["on_time"] / r["due"], 1) if r["due"] else None
        out.append(r)
    return rank(out)


def _plans_in(start, end, farms) -> list:
    rows = frappe.db.sql(
        """SELECT wo.name, wo.custom_greenhouse AS greenhouse, wo.status, wo.workflow_state,
                  wo.custom_scheduled_application_time AS scheduled, wo.actual_start_date,
                  (SELECT MIN(s.started_at) FROM `tabSprayer Movement Session` s
                    WHERE s.work_order = wo.name AND IFNULL(s.status, '') != 'Aborted') AS session_start,
                  wh.custom_farm AS farm
             FROM `tabWork Order` wo
             LEFT JOIN `tabWarehouse` wh ON wh.name = wo.custom_greenhouse
            WHERE wo.custom_type = %s AND wo.docstatus = 1
              AND wo.custom_scheduled_application_time >= %s
              AND wo.custom_scheduled_application_time < %s""",
        (AFP, start, getdate(end) + timedelta(days=1)), as_dict=True,
    )
    if farms is not None:
        rows = [r for r in rows if r.farm in farms]
    return [{
        "name": r.name, "scheduled": r.scheduled,
        "start": r.session_start or r.actual_start_date,
        "completed": (r.workflow_state == "Completed") or (r.status in ("Completed", "Closed")),
        "stopped": r.status == "Stopped", "farm": r.farm,
    } for r in rows]


def supervisor_kpis(start, end, farms=None, now=None) -> dict:
    now = now or now_datetime()
    plans = _plans_in(start, end, farms)
    names_of_plans = [p["name"] for p in plans]
    sup = _supervisors_by_plan(names_of_plans)
    scan = _scanners_by_plan(names_of_plans)
    emps = [e for v in sup.values() for e in v] + [e for v in scan.values() for e in v]
    rows = build_rows(plans, sup, {k: v for k, v in scan.items()}, now, _names(emps))
    return {
        "from_date": str(getdate(start)), "to_date": str(getdate(end)), "grace_hours": GRACE_HOURS,
        "plans": len(plans), "no_supervisor": sum(1 for p in plans if not sup.get(p["name"])),
        "rows": rows,
    }


@frappe.whitelist()
def get_supervisors(crop=None, farm=None, from_date=None, to_date=None) -> dict:
    """Personnel ▸ Supervisors: the ranking over the range (default: last four
    complete weeks). Same farm scope as the Teams page."""
    sc = personnel_api.scope(crop)
    visible = sc["farms"]
    farm = (farm or "").strip()
    if farm:
        personnel_api._assert_farm(sc, farm)
        farms = {farm}
    else:
        farms = visible
    today = getdate(frappe.utils.nowdate())
    sunday = today - timedelta(days=today.isoweekday() % 7 or 7)
    start = getdate(from_date) if from_date else sunday - timedelta(days=27)
    end = getdate(to_date) if to_date else sunday
    out = supervisor_kpis(start, end, farms)
    out["farms"] = sorted(visible) if visible is not None else sorted(frappe.get_all("Farm", pluck="name"))
    out["farm"] = farm
    return out
