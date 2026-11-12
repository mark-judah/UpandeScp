"""Spray supervisor accountability: who was meant to run a spray, who did.

Two views of the same fact.

``accountability(plans)`` answers, for specific plans: the supervisor(s) on the
plan's team (``custom_spray_plan_team_members`` rows with role Supervisor) and
whoever actually scanned a chemical at the CSU or started spraying (a Work Order
Chemical Scan's ``scanned_by``, a Sprayer Movement Session's employee), or that
nobody did. The lifecycle, the Chemical Progress page and the progress email
show both, so a missed spray names the person assigned and the person who acted.

``get_supervisors`` ranks supervisors over a date range (Personnel ▸
Supervisors); ``supervisor_kpis.py`` adds the extensive per-supervisor KPIs, farm
medians, weekly trend and plan events that page shows. A plan belongs to its day (the scheduled application time) and to
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

import json
from datetime import datetime, timedelta

import frappe
from frappe.utils import get_datetime, getdate, now_datetime

from upande_scp.serverscripts.common.place_filter import parse_names
from upande_scp.serverscripts.scouts import api as scouts_api
from upande_scp.serverscripts.spray_plan_creator import lateness
from upande_scp.serverscripts.sprayers import api as personnel_api
from upande_scp.serverscripts.sprayers import supervisor_kpis as K

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
                  wo.custom_area AS area, wo.custom_compliance_status AS compliance,
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
        "name": r.name, "scheduled": r.scheduled, "greenhouse": r.greenhouse, "area": r.area,
        "compliance": r.compliance,
        "start": r.session_start or r.actual_start_date,
        "completed": (r.workflow_state == "Completed") or (r.status in ("Completed", "Closed")),
        "stopped": r.status == "Stopped", "farm": r.farm,
    } for r in rows]


def _cutoff_cache():
    cache: dict = {}

    def cutoff_of(greenhouse):
        crop = lateness.crop_of_greenhouse(greenhouse)
        if crop not in cache:
            cache[crop] = lateness.cutoff_for(crop)
        return cache[crop]

    return cutoff_of


def enrich(rows, plans, sup, scan, ctx, now, names, cutoff_of=None) -> dict:
    """Add the KPI fields, radar, weekly trend and plan events to each row and
    return ``{"rows", "medians"}``. Pure given its inputs (``ctx`` is
    ``supervisor_kpis.load_context`` with ``checkins``)."""
    cutoff_of = cutoff_of or (lambda gh: lateness.DEFAULT_CUTOFF)
    facts = {p["name"]: K.plan_facts(p, ctx, now, classify, cutoff_of) for p in plans}
    actors = {n: [names.get(e) or e for e in scan.get(n, {})] for n in facts}
    mine: dict = {}
    for p in plans:
        for e in dict.fromkeys(sup.get(p["name"], [])):
            mine.setdefault(e, []).append(facts[p["name"]])
    for r in rows:
        fs = mine.get(r["employee"], [])
        r.update(K.summarise(fs, {"acted": r["acted"], "by_other": r["by_other"], "nobody": r["nobody"]}))
        r["farm"] = K.primary_farm(fs)
        r["farms"] = sorted({f["farm"] for f in fs if f["farm"]})
        r["weeks"] = K.weeks_of(fs)
        r["events"] = K.events_of(fs, actors)
    pace_ref = K.median([r["median_spray_min"] for r in rows])
    for r in rows:
        r["radar"] = {k: (None if v is None else round(v, 3)) for k, v in K.radar_of(r, pace_ref).items()}
        r["score"] = K.score_of(r["radar"])
    return {"rows": rows, "medians": K.farm_medians(rows), "pace_ref_min": pace_ref}


def supervisor_kpis(start, end, farms=None, now=None) -> dict:
    now = now or now_datetime()
    plans = _plans_in(start, end, farms)
    names_of_plans = [p["name"] for p in plans]
    sup = _supervisors_by_plan(names_of_plans)
    scan = _scanners_by_plan(names_of_plans)
    emps = [e for v in sup.values() for e in v] + [e for v in scan.values() for e in v]
    names = _names(emps)
    rows = build_rows(plans, sup, {k: v for k, v in scan.items()}, now, names)
    ctx = K.load_context(plans)
    ctx["checkins"] = K.load_checkins(
        plans, ctx, {p["name"]: getdate(p["start"]) for p in plans if p["start"]})
    out = enrich(rows, plans, sup, scan, ctx, now, names, _cutoff_cache())
    out.update({
        "from_date": str(getdate(start)), "to_date": str(getdate(end)), "grace_hours": GRACE_HOURS,
        "plans": len(plans), "no_supervisor": sum(1 for p in plans if not sup.get(p["name"])),
    })
    return out


@frappe.whitelist()
def get_supervisors(crop=None, farm=None, from_date=None, to_date=None) -> dict:
    """Personnel ▸ Supervisors: the ranking and each supervisor's KPIs over the
    range (default: last four complete weeks). Same farm scope as the Teams page;
    ``farm`` may name several (JSON list), ``__all__`` or blank means every farm
    the user may see."""
    sc = personnel_api.scope(crop)
    visible = sc["farms"]
    names = parse_names(farm)
    for n in names:
        personnel_api._assert_farm(sc, n)
    farms = set(names) if names else visible
    today = getdate(frappe.utils.nowdate())
    sunday = today - timedelta(days=today.isoweekday() % 7 or 7)
    start = getdate(from_date) if from_date else sunday - timedelta(days=27)
    end = getdate(to_date) if to_date else sunday
    out = supervisor_kpis(start, end, farms)
    ids = [r["employee"] for r in out["rows"]]
    leave = scouts_api.approved_leave_days(ids, start, end) if ids else {}
    images = scouts_api._images(ids)
    for r in out["rows"]:
        r["leave_days"] = leave.get(r["employee"], 0)
        r["image"] = images.get(r["employee"], "")
    out["farms"] = sorted(visible) if visible is not None else sorted(frappe.get_all("Farm", pluck="name"))
    out["farm"] = names[0] if len(names) == 1 else (json.dumps(names) if names else "")
    return out
