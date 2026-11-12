"""Per-supervisor KPIs for Personnel ▸ Supervisors.

Everything here is computed over a date range from records the spray flow already
writes; nothing is stored. A plan belongs to its day (the scheduled application
time) and to each supervisor on its team (``Custom Spray Plan Team Member`` rows
with role Supervisor, up to two per plan).

The shaping is split in two so it is tested without a database:

* ``plan_facts`` turns one plan and what is known about it into a flat dict
  (outcome, minutes, offline or not, team attendance ...). Pure.
* ``summarise`` folds a supervisor's plan facts into the KPI row, ``radar_of``
  normalises six scores, ``farm_medians`` takes the median of each across a farm.

Definitions worth knowing (also shown on the page):

* Outcome (on time / late / missed / never started) is the existing
  ``supervisors.classify``. Lateness is graded with ``lateness.grade`` evaluated at
  the moment spraying actually started: amber / orange / red across the window to
  the day's cutoff, ``past_cutoff`` after it.
* Spray duration is the spray session's start to end; tank-mix to start is the
  offline token's ``mix_at`` or, online, the Manufacture Stock Entry's creation.
* A plan ran **offline** when its Spray Session Token was synced at least
  ``OFFLINE_LAG_MIN`` minutes after the spray ended (the handset held it until it
  had signal). Sync time is that lag, spray end to ``synced_at``.
* Team attendance: on a plan that started, each member with no IN punch in
  Employee Checkin on the day it sprayed is one absent member-day; a plan whose whole
  crew has no punch that day is left out (Time & Attendance has no record of it).
* Not computable from existing data: team edits made offline (the replay overwrites
  the team table and keeps no before/after); tokens carry the crew warnings raised
  instead.
"""
from __future__ import annotations

import statistics
from datetime import date, datetime, timedelta

import frappe
from frappe.utils import get_datetime, getdate

from upande_scp.serverscripts.spray_plan_creator import lateness

#: A token synced this long after the spray ended means the handset was offline.
OFFLINE_LAG_MIN = 10
#: Spray end to server sync at which the sync score reaches zero.
SYNC_ZERO_MIN = 12 * 60
#: Events kept per supervisor for the activity feed.
EVENT_CAP = 40

RADAR_KEYS = ("punctuality", "completion", "accountability", "sync", "attendance", "pace")


def _chunks(seq, n=1000):
    seq = list(seq)
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


# ── pure helpers ────────────────────────────────────────────────────────────


def median(values):
    xs = [v for v in values if v is not None]
    return round(statistics.median(xs), 1) if xs else None


def minutes_between(a, b):
    """(b - a) in minutes, or None when either is missing."""
    if not a or not b:
        return None
    return (get_datetime(b) - get_datetime(a)).total_seconds() / 60.0


def _non_negative(v):
    """A tank-mix timestamp after the spray started is a back-dated record, not a duration."""
    return v if v is not None and v >= 0 else None


def pct(n, d):
    return round(100.0 * n / d, 1) if d else None


def yearweek(d) -> int:
    iso = getdate(d).isocalendar()
    return iso[0] * 100 + iso[1]


def late_grade(scheduled, start, cutoff) -> str | None:
    """Grade of a late start: amber / orange / red, or ``past_cutoff``. Pure."""
    if not scheduled or not start:
        return None
    level = lateness.grade(scheduled, now=start, cutoff=cutoff, open_plan=True)["level"]
    if level == "missed":
        return "past_cutoff"
    return level if level in ("amber", "orange", "red") else "amber"


def plan_facts(plan: dict, ctx: dict, now, classify, cutoff_of=lambda gh: lateness.DEFAULT_CUTOFF) -> dict:
    """One plan's facts. ``ctx`` holds the lookups, each keyed by plan name:
    sessions {start, end}, tokens [..], mix, scans (required, scanned), team [..],
    checkins {(employee, date)}, postponements, refusals. Pure."""
    name = plan["name"]
    start = plan["start"]
    outcome = classify(plan["scheduled"], start, now, stopped=plan["stopped"])
    sess = (ctx.get("sessions") or {}).get(name) or {}
    tokens = (ctx.get("tokens") or {}).get(name) or []
    started = bool(start)

    grade = None
    if outcome == "late":
        grade = late_grade(plan["scheduled"], start, cutoff_of(plan.get("greenhouse")))

    mix = None
    for t in tokens:
        if t.get("mix_at"):
            mix = t["mix_at"]
            break
    mix = mix or (ctx.get("mix") or {}).get(name)

    lag = None
    for t in tokens:
        if t.get("status") in ("Synced", "Partial") and t.get("synced_at") and t.get("ended_at"):
            m = minutes_between(t["ended_at"], t["synced_at"])
            if m is not None:
                lag = max(lag if lag is not None else 0.0, max(0.0, m))
    offline = None
    if started or tokens:
        offline = bool(lag is not None and lag >= OFFLINE_LAG_MIN)

    team = (ctx.get("team") or {}).get(name) or []
    day = getdate(start) if start else None
    absent = 0
    member_days = 0
    if day and team:
        checkins = ctx.get("checkins") or set()
        present = sum(1 for m in team if (m["employee"], day) in checkins)
        # No punch from anyone on the crew means Time & Attendance has nothing for
        # them that day (unlinked or not loaded), not that everyone stayed away.
        if present:
            member_days = len(team)
            absent = len(team) - present

    required, scanned = (ctx.get("scans") or {}).get(name) or (0, 0)
    return {
        "name": name, "greenhouse": plan.get("greenhouse"), "farm": plan.get("farm"),
        "scheduled": plan["scheduled"], "start": start, "end": sess.get("end"),
        "completed": bool(plan["completed"]), "outcome": outcome, "grade": grade,
        "delay_min": minutes_between(plan["scheduled"], start),
        "mix_to_start_min": _non_negative(minutes_between(mix, sess.get("start") or start)),
        "spray_min": minutes_between(sess.get("start"), sess.get("end")),
        "started": started, "offline": offline, "sync_min": lag,
        "tokens": [t.get("status") or "" for t in tokens],
        "crew_warnings": sum(1 for t in tokens if (t.get("crew_warnings") or "").strip()),
        "team_size": len(team), "absent": absent, "member_days": member_days,
        "area": float(plan.get("area") or 0), "day": day,
        "scan_required": required, "scan_done": scanned,
        "postponements": (ctx.get("postponements") or {}).get(name, 0),
        "refusals": (ctx.get("refusals") or {}).get(name, 0),
        "compliance": plan.get("compliance") or "",
    }


def summarise(facts: list[dict], acting: dict) -> dict:
    """The KPI fields for one supervisor from their plans' facts.

    ``acting`` is {"acted": n, "by_other": n, "nobody": n} — who scanned what,
    computed alongside the existing accountability."""
    n = len(facts)
    done = sum(1 for f in facts if f["completed"])
    due = [f for f in facts if f["outcome"]]
    on_time = sum(1 for f in due if f["outcome"] == "on_time")
    grades = [f["grade"] for f in facts if f["grade"]]
    ran = [f for f in facts if f["started"]]
    days = {f["day"] for f in ran if f["day"]}
    houses = {f["greenhouse"] for f in ran if f["greenhouse"]}
    off = [f for f in facts if f["offline"] is True]
    onl = [f for f in facts if f["offline"] is False]
    tok = [s for f in facts for s in f["tokens"]]
    sized = [f["team_size"] for f in facts if f["team_size"]]
    md = sum(f["member_days"] for f in facts)
    ab = sum(f["absent"] for f in facts)
    needing = [f for f in facts if f["scan_required"]]
    return {
        "assigned": n,
        "completed": done,
        "completion_rate": pct(done, n),
        "due": len(due),
        "on_time": on_time,
        "late": sum(1 for f in due if f["outcome"] == "late"),
        "missed": sum(1 for f in due if f["outcome"] == "missed"),
        "never_started": sum(1 for f in due if f["outcome"] == "never_started"),
        "on_time_pct": pct(on_time, len(due)),
        "late_amber": grades.count("amber"),
        "late_orange": grades.count("orange"),
        "late_red": grades.count("red"),
        "late_past_cutoff": grades.count("past_cutoff"),
        "median_start_delay_min": median([f["delay_min"] for f in ran]),
        "acted": acting.get("acted", 0),
        "by_other": acting.get("by_other", 0),
        "nobody": acting.get("nobody", 0),
        "accountability_pct": pct(acting.get("acted", 0), n),
        "median_mix_to_start_min": median([f["mix_to_start_min"] for f in facts]),
        "median_spray_min": median([f["spray_min"] for f in facts]),
        "greenhouses_sprayed": len(houses),
        "greenhouses_per_day": round(len(ran) / len(days), 1) if days else None,
        "hectares": round(sum(f["area"] for f in ran), 2),
        "scan_plans_complete": sum(1 for f in needing if f["scan_done"] >= f["scan_required"]),
        "scan_plans": len(needing),
        "offline_plans": len(off),
        "online_plans": len(onl),
        "offline_share": pct(len(off), len(off) + len(onl)),
        "tokens_held": sum(1 for s in tok if s.startswith("Held")),
        "tokens_partial": tok.count("Partial"),
        "tokens_refused": tok.count("Refused"),
        "median_sync_min": median([f["sync_min"] for f in off]),
        "avg_team_size": round(sum(sized) / len(sized), 1) if sized else None,
        "member_days": md,
        "absent_member_days": ab,
        "absence_rate": pct(ab, md),
        "crew_warnings": sum(f["crew_warnings"] for f in facts),
        "postponements": sum(f["postponements"] for f in facts),
        "compliance_warnings": sum(1 for f in facts if f["compliance"] == "Warnings"),
        "compliance_overridden": sum(1 for f in facts if f["compliance"] == "Overridden"),
        "compliance_awaiting": sum(1 for f in facts if f["compliance"] == "Awaiting Override"),
        "refusals": sum(f["refusals"] for f in facts),
    }


def radar_of(k: dict, pace_ref=None) -> dict:
    """Six 0-1 scores, outward is better; None where there is nothing to judge by.

    * punctuality: share of due plans started on time.
    * completion: share of assigned plans completed.
    * accountability: share of assigned plans the supervisor scanned / started.
    * sync: 1 for a spray synced at once, falling to 0 at ``SYNC_ZERO_MIN`` minutes
      after it ended (median over their offline sprays).
    * attendance: 1 minus the share of listed members with no check-in.
    * pace: spray duration against ``pace_ref`` (the median across supervisors):
      the median supervisor scores 0.5, twice as fast 1.0.
    """
    def frac(v):
        return None if v is None else max(0.0, min(1.0, v / 100.0))

    sync = k.get("median_sync_min")
    spray = k.get("median_spray_min")
    return {
        "punctuality": frac(k.get("on_time_pct")),
        "completion": frac(k.get("completion_rate")),
        "accountability": frac(k.get("accountability_pct")),
        "sync": None if sync is None else max(0.0, 1.0 - sync / SYNC_ZERO_MIN),
        "attendance": None if k.get("absence_rate") is None else frac(100.0 - k["absence_rate"]),
        "pace": None if not spray or not pace_ref else max(0.0, min(1.0, 0.5 * pace_ref / spray)),
    }


def score_of(radar: dict):
    vals = [v for v in radar.values() if v is not None]
    return round(100.0 * sum(vals) / len(vals), 1) if vals else None


#: Numeric fields the farm median is taken over.
MEDIAN_FIELDS = (
    "completion_rate", "on_time_pct", "median_start_delay_min", "accountability_pct",
    "median_mix_to_start_min", "median_spray_min", "greenhouses_per_day", "offline_share",
    "median_sync_min", "avg_team_size", "absence_rate", "assigned", "hectares",
)


def farm_medians(rows: list[dict]) -> list[dict]:
    """One entry per primary farm: the median of each KPI and radar axis across its
    supervisors. Pure."""
    by_farm: dict = {}
    for r in rows:
        by_farm.setdefault(r.get("farm"), []).append(r)
    out = []
    for farm, rs in sorted(by_farm.items(), key=lambda kv: str(kv[0])):
        e = {"farm": farm, "supervisors": len(rs)}
        for f in MEDIAN_FIELDS:
            e[f] = median([r.get(f) for r in rs])
        e["radar"] = {a: median([(r["radar"].get(a) if r.get("radar") else None) for r in rs]) for a in RADAR_KEYS}
        e["radar"] = {a: (None if v is None else round(v, 3)) for a, v in e["radar"].items()}
        out.append(e)
    return out


def primary_farm(facts: list[dict]):
    counts: dict = {}
    for f in facts:
        if f["farm"]:
            counts[f["farm"]] = counts.get(f["farm"], 0) + 1
    return max(counts.items(), key=lambda kv: (kv[1], kv[0]))[0] if counts else None


def weeks_of(facts: list[dict]) -> list[dict]:
    wk: dict = {}
    for f in facts:
        if not f["scheduled"]:
            continue
        w = wk.setdefault(yearweek(f["scheduled"]), {"week": yearweek(f["scheduled"]), "plans": 0, "due": 0,
                                                     "on_time": 0, "completed": 0})
        w["plans"] += 1
        if f["outcome"]:
            w["due"] += 1
            if f["outcome"] == "on_time":
                w["on_time"] += 1
        if f["completed"]:
            w["completed"] += 1
    return [wk[k] for k in sorted(wk)]


def events_of(facts: list[dict], actors: dict) -> list[dict]:
    """Newest-first plan events for the activity feed. ``actors`` plan -> [names]."""
    out = []
    for f in sorted(facts, key=lambda f: str(f["scheduled"]), reverse=True)[:EVENT_CAP]:
        flags = []
        if f["postponements"]:
            flags.append("postponed")
        if f["refusals"]:
            flags.append("refused")
        if f["compliance"] in ("Warnings", "Overridden", "Awaiting Override"):
            flags.append(f["compliance"].lower())
        if f["offline"]:
            flags.append("offline")
        if f["absent"]:
            flags.append(f"{f['absent']} absent")
        out.append({
            "plan": f["name"], "greenhouse": f["greenhouse"], "farm": f["farm"],
            "scheduled": str(f["scheduled"]) if f["scheduled"] else None,
            "started": str(f["start"]) if f["start"] else None,
            "outcome": f["outcome"], "grade": f["grade"], "completed": f["completed"],
            "delay_min": None if f["delay_min"] is None else round(f["delay_min"], 1),
            "spray_min": None if f["spray_min"] is None else round(f["spray_min"], 1),
            "acted_by": actors.get(f["name"], []), "flags": flags,
        })
    return out


# ── database lookups (one query per table, chunked) ─────────────────────────


def load_context(plans: list[dict]) -> dict:
    names = [p["name"] for p in plans]
    ctx = {"sessions": {}, "tokens": {}, "mix": {}, "scans": {}, "team": {}, "postponements": {},
           "refusals": {}, "checkins": set()}
    if not names:
        return ctx
    for c in _chunks(names):
        t = tuple(c)
        for wo, s, e in frappe.db.sql(
            """SELECT work_order, MIN(started_at), MAX(ended_at) FROM `tabSprayer Movement Session`
                WHERE work_order IN %s AND IFNULL(status, '') != 'Aborted' GROUP BY work_order""", (t,)):
            ctx["sessions"][wo] = {"start": s, "end": e}
        for r in frappe.db.sql(
            """SELECT work_order, status, mix_at, started_at, ended_at, synced_at, crew_warnings
                 FROM `tabSpray Session Token` WHERE work_order IN %s ORDER BY creation""", (t,), as_dict=True):
            ctx["tokens"].setdefault(r.work_order, []).append(r)
        for wo, at in frappe.db.sql(
            """SELECT work_order, MIN(creation) FROM `tabStock Entry`
                WHERE work_order IN %s AND docstatus = 1 AND purpose = 'Manufacture' GROUP BY work_order""", (t,)):
            ctx["mix"][wo] = at
        for wo, req, done in frappe.db.sql(
            """SELECT r.parent, COUNT(DISTINCT r.item_code),
                      COUNT(DISTINCT CASE WHEN s.item_code IS NOT NULL THEN r.item_code END)
                 FROM `tabWork Order Item` r
                 LEFT JOIN `tabWork Order Chemical Scan` s
                        ON s.parent = r.parent AND s.parenttype = 'Work Order' AND s.item_code = r.item_code
                WHERE r.parenttype = 'Work Order' AND r.parent IN %s GROUP BY r.parent""", (t,)):
            ctx["scans"][wo] = (int(req or 0), int(done or 0))
        for wo, emp, role in frappe.db.sql(
            """SELECT parent, employee, role FROM `tabCustom Spray Plan Team Member`
                WHERE parenttype = 'Work Order' AND parent IN %s AND IFNULL(employee, '') != ''""", (t,)):
            ctx["team"].setdefault(wo, []).append({"employee": emp, "role": role})
        if frappe.db.table_exists("Spray Plan Postponement"):
            for wo, n in frappe.db.sql(
                """SELECT work_order, COUNT(*) FROM `tabSpray Plan Postponement`
                    WHERE work_order IN %s AND IFNULL(status, '') NOT IN ('Withdrawn', 'Rejected')
                 GROUP BY work_order""", (t,)):
                ctx["postponements"][wo] = int(n)
        for wo, n in frappe.db.sql(
            """SELECT reference_name, COUNT(*) FROM `tabError Log`
                WHERE reference_name IN %s AND method = 'Spray session refused' GROUP BY reference_name""", (t,)):
            ctx["refusals"][wo] = int(n)
    return ctx


def load_checkins(plans: list[dict], ctx: dict, facts_days: dict) -> set:
    """{(employee, date)} with an IN punch, for the members of plans that started.
    ``facts_days`` plan -> day of spraying."""
    wanted: dict = {}
    for p in plans:
        day = facts_days.get(p["name"])
        if not day:
            continue
        for m in ctx["team"].get(p["name"], []):
            wanted.setdefault(m["employee"], set()).add(day)
    out: set = set()
    if not wanted or not frappe.db.table_exists("Employee Checkin"):
        return out
    lo, hi = min(min(d) for d in wanted.values()), max(max(d) for d in wanted.values())
    for c in _chunks(wanted, 500):
        for emp, at in frappe.db.sql(
            """SELECT employee, DATE(`time`) FROM `tabEmployee Checkin`
                WHERE employee IN %s AND log_type = 'IN' AND `time` >= %s AND `time` < %s
             GROUP BY employee, DATE(`time`)""", (tuple(c), f"{lo} 00:00:00", f"{hi + timedelta(days=1)} 00:00:00")):
            out.add((emp, getdate(at)))
    return out
