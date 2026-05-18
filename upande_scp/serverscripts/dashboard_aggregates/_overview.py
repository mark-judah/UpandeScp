"""Overview tab aggregator."""

import frappe

from upande_scp.serverscripts import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    parent_filter_conditions,
    publish_progress,
    resolve_greenhouse_scope,
)


def overview(args: dict, force: bool = False) -> dict:
    """Return the Overview tab payload (9 aggregations).

    See spec §API Contract for the exact response shape.
    """
    from_date = args.get("from_date", "")
    to_date   = args.get("to_date", "")
    crop      = (args.get("crop") or "").strip()
    farm      = (args.get("farm") or "").strip()
    gh        = (args.get("greenhouse") or "").strip()
    job_id    = (args.get("job_id") or "").strip()

    farms_map = scouting_metrics.get_farms_and_warehouses() or {}
    scope = resolve_greenhouse_scope(gh, farm, farms_map)

    cache_filters = {
        "from_date": from_date, "to_date": to_date,
        "crop": crop, "farm": farm, "greenhouse": gh,
    }
    return cached_aggregate(
        "overview",
        cache_filters,
        lambda: _build(from_date, to_date, crop, scope, job_id),
        force=force,
    )


def _build(from_date, to_date, crop, scope, job_id: str = "") -> dict:
    publish_progress(job_id, 5, "resolving filters")
    where, params = parent_filter_conditions(from_date, to_date, crop, scope)

    publish_progress(job_id, 15, "counting entries")
    kpis    = _kpis(where, params)

    publish_progress(job_id, 35, "loading observations")
    obs     = _observation_rows(where, params)

    publish_progress(job_id, 85, "computing summaries")
    daily, range_totals = _daily_and_totals(obs)
    gh_health, alerts_total = _gh_health(obs)
    active = _active_alerts(obs)
    top_scouts, scouts_per_day, scout_perf = _scout_aggs(obs)

    publish_progress(job_id, 95, "loading recent activity")
    recent = _recent_activity(where, params)

    kpis["highAlerts"] = alerts_total

    publish_progress(job_id, 100, "")
    return {
        "kpis": kpis,
        "daily": daily,
        "rangeTotals": range_totals,
        "ghHealth": gh_health,
        "topScouts": top_scouts,
        "scoutsPerDay": scouts_per_day,
        "scoutPerformance": scout_perf,
        "recentActivity": recent,
        "activeAlerts": active,
    }


def _kpis(where: str, params: dict) -> dict:
    row = frappe.db.sql(
        f"""
        SELECT
            COUNT(DISTINCT se.scouts_name) AS total_scouts,
            COUNT(DISTINCT se.name)        AS zones_scouted,
            COUNT(DISTINCT COALESCE(NULLIF(se.greenhouse, ''), se.block)) AS gh_count
        FROM `tabScouting Entry` se
        WHERE {where}
        """,
        params,
        as_dict=True,
    )[0] or {}
    return {
        "totalScouts":     int(row.get("total_scouts") or 0),
        "zonesScouted":    int(row.get("zones_scouted") or 0),
        "greenhouseCount": int(row.get("gh_count") or 0),
        "highAlerts":      0,  # overwritten in _build after _gh_health runs
    }


def _observation_rows(where: str, params: dict) -> list:
    """One row per (entry, observation kind, observation row). Sub-queries
    UNION pests/diseases/traps so a single Python pass can derive most of
    the Overview metrics."""
    return frappe.db.sql(
        f"""
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               se.scouts_name, se.zone, se.bed, se.tree,
               'pest'    AS kind,
               p.pest    AS obs_name, p.count AS count,
               p.stage   AS stage,    p.plant_section AS plant_section
        FROM `tabScouting Entry` se
        JOIN `tabPests Scouting Entry` p ON p.parent = se.name
        WHERE {where}
        UNION ALL
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               se.scouts_name, se.zone, se.bed, se.tree,
               'disease' AS kind,
               d.disease AS obs_name, NULL AS count,
               d.stage   AS stage, d.plant_section AS plant_section
        FROM `tabScouting Entry` se
        JOIN `tabDiseases Scouting Entry` d ON d.parent = se.name
        WHERE {where}
        UNION ALL
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               se.scouts_name, se.zone, se.bed, se.tree,
               'trap'    AS kind,
               t.trap    AS obs_name, t.count AS count,
               NULL      AS stage, t.location AS plant_section
        FROM `tabScouting Entry` se
        JOIN `tabTrap Scouting Entry` t ON t.parent = se.name
        WHERE {where}
        """,
        params,
        as_dict=True,
    )


def _daily_and_totals(obs: list) -> tuple:
    """Counts a row per (date, kind). One observation = one count; this mirrors
    the JS aggregator's append() which pushes one element per child row."""
    by_date = {}
    totals = {"pests": 0, "diseases": 0, "traps": 0}
    for r in obs:
        d = str(r.date_of_capture)[:10]
        bucket = by_date.setdefault(d, {"date": d, "pests": 0, "diseases": 0, "traps": 0})
        if r.kind == "pest":
            bucket["pests"] += 1
            totals["pests"] += 1
        elif r.kind == "disease":
            bucket["diseases"] += 1
            totals["diseases"] += 1
        elif r.kind == "trap":
            bucket["traps"] += 1
            totals["traps"] += 1
    return sorted(by_date.values(), key=lambda x: x["date"]), totals


def _gh_health(obs: list) -> tuple:
    """Per-greenhouse counts + alert count. Alert rule:
       - pest count > 15 → +1 alert
       - disease severity high/active/severe → +1 alert
       - trap count > 10 → +1 alert (matches greenhouseDetail in aggregate.ts)"""
    from upande_scp.serverscripts.dashboard_aggregates._common import (
        pest_severity, disease_severity,
    )
    by_gh = {}
    total_alerts = 0
    scouts_by_gh = {}
    for r in obs:
        gh = r.greenhouse or r.block or "—"
        bucket = by_gh.setdefault(gh, {"name": gh, "pests": 0, "diseases": 0,
                                       "traps": 0, "scoutCount": 0, "alerts": 0})
        scouts_by_gh.setdefault(gh, set()).add(r.scouts_name or "")
        if r.kind == "pest":
            bucket["pests"] += 1
            if pest_severity(r.count) == "high":
                bucket["alerts"] += 1
                total_alerts += 1
        elif r.kind == "disease":
            bucket["diseases"] += 1
            if disease_severity(r.stage) == "high":
                bucket["alerts"] += 1
                total_alerts += 1
        elif r.kind == "trap":
            bucket["traps"] += 1
            if (r.count or 0) > 10:
                bucket["alerts"] += 1
                total_alerts += 1
    for gh, bucket in by_gh.items():
        bucket["scoutCount"] = len([s for s in scouts_by_gh[gh] if s])
        a = bucket["alerts"]
        bucket["status"] = "critical" if a > 2 else "warning" if a > 0 else "good"
    out = sorted(
        by_gh.values(),
        key=lambda x: x["pests"] + x["diseases"] + x["traps"],
        reverse=True,
    )
    return out, total_alerts


def _active_alerts(obs: list, n: int = 8) -> list:
    from upande_scp.serverscripts.dashboard_aggregates._common import (
        pest_severity, disease_severity,
    )
    out = []
    for r in obs:
        gh   = r.greenhouse or r.block or "—"
        zone = r.zone or r.tree or ""
        date = str(r.date_of_capture)[:10]
        if r.kind == "pest":
            sev = pest_severity(r.count)
            if sev:
                out.append({"name": r.obs_name, "kind": "pest", "severity": sev,
                            "count": int(r.count or 0),
                            "greenhouse": gh, "zone": zone, "date": date})
        elif r.kind == "disease":
            sev = disease_severity(r.stage)
            if sev:
                out.append({"name": r.obs_name, "kind": "disease", "severity": sev,
                            "count": 1,
                            "greenhouse": gh, "zone": zone, "date": date})
    # JS comparator: high-first, then date desc. Python list.sort is stable,
    # so sort by date desc first (secondary key), then by severity (primary).
    out.sort(key=lambda a: a["date"], reverse=True)
    out.sort(key=lambda a: a["severity"] != "high")
    return out[:n]


def _scout_aggs(obs: list) -> tuple:
    """Returns (topScouts, scoutsPerDay, scoutPerformance) — all keyed by scoutId."""
    entries_by_scout = {}
    obs_by_scout = {}
    scouts_by_date = {}
    seen_entries = set()
    for r in obs:
        sid = (r.scouts_name or "").strip()
        date = str(r.date_of_capture)[:10]
        if not sid:
            continue
        if r.name not in seen_entries:
            seen_entries.add(r.name)
            entries_by_scout[sid] = entries_by_scout.get(sid, 0) + 1
            scouts_by_date.setdefault(date, set()).add(sid)
        ob = obs_by_scout.setdefault(sid, {"pests": 0, "diseases": 0})
        if r.kind == "pest":
            ob["pests"] += 1
        elif r.kind == "disease":
            ob["diseases"] += 1
    top = [{"scoutId": s, "entries": n} for s, n in entries_by_scout.items()]
    top.sort(key=lambda x: x["entries"], reverse=True)
    perf = [
        {"scoutId": s, "zones": entries_by_scout.get(s, 0),
         "pests": ob["pests"], "diseases": ob["diseases"]}
        for s, ob in obs_by_scout.items()
    ]
    perf.sort(key=lambda x: x["zones"], reverse=True)
    spd = [{"date": d, "scouts": len(s)} for d, s in scouts_by_date.items()]
    spd.sort(key=lambda x: x["date"])
    return top[:6], spd, perf[:8]


def _recent_activity(where: str, params: dict, n: int = 8) -> list:
    """Top N most recent entries with their primary observation kind."""
    rows = frappe.db.sql(
        f"""
        SELECT se.name, se.date_of_capture, se.time_of_capture,
               se.greenhouse, se.block, se.zone, se.tree, se.scouts_name,
               EXISTS(SELECT 1 FROM `tabPests Scouting Entry` p WHERE p.parent = se.name)    AS has_pest,
               EXISTS(SELECT 1 FROM `tabDiseases Scouting Entry` d WHERE d.parent = se.name) AS has_disease,
               EXISTS(SELECT 1 FROM `tabTrap Scouting Entry` t WHERE t.parent = se.name)     AS has_trap
        FROM `tabScouting Entry` se
        WHERE {where}
        ORDER BY se.date_of_capture DESC, se.time_of_capture DESC
        LIMIT %(limit)s
        """,
        {**params, "limit": n},
        as_dict=True,
    )
    out = []
    for r in rows:
        kind = ("pest"    if r.has_pest
                else "disease" if r.has_disease
                else "trap"    if r.has_trap
                else "other")
        out.append({
            "name":       r.name,
            "date":       str(r.date_of_capture)[:10],
            "time":       str(r.time_of_capture or ""),
            "greenhouse": r.greenhouse or r.block or "—",
            "zone":       r.zone or r.tree or "",
            "scoutId":    r.scouts_name or "",
            "kind":       kind,
        })
    return out
