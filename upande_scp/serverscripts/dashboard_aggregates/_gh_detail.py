"""Greenhouse drill-down used by GreenhouseModal."""

import frappe

from upande_scp.serverscripts.scouting import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    parent_filter_conditions,
    publish_progress,
    severity_for,
)


def greenhouse_detail(args: dict, force: bool = False) -> dict:
    gh = (args.get("greenhouse") or "").strip()
    job_id = (args.get("job_id") or "").strip()
    filters = {
        "greenhouse": gh,
        "from_date":  args.get("from_date", ""),
        "to_date":    args.get("to_date", ""),
        "crop":       (args.get("crop") or "").strip(),
    }
    if not gh:
        return _empty()
    return cached_aggregate(
        "greenhouse_detail", filters, lambda: _build(filters, job_id), force=force,
    )


def _empty() -> dict:
    return {"topPests": [], "topDiseases": [], "traps": [], "daily": [],
            "scouts": 0, "alerts": 0}


def _build(filters: dict, job_id: str = "") -> dict:
    publish_progress(job_id, 10, "resolving filters")
    where, params = parent_filter_conditions(
        filters["from_date"], filters["to_date"], filters["crop"],
        [filters["greenhouse"]],
    )

    publish_progress(job_id, 25, "loading pest rows")
    pests = frappe.db.sql(f"""
        SELECT se.name, se.date_of_capture, se.zone, p.pest, p.stage, p.count
        FROM `tabScouting Entry` se
        JOIN `tabPests Scouting Entry` p ON p.parent = se.name
        WHERE {where}
    """, params, as_dict=True)

    publish_progress(job_id, 50, "loading disease rows")
    diseases = frappe.db.sql(f"""
        SELECT se.name, se.date_of_capture, se.zone, d.disease, d.stage
        FROM `tabScouting Entry` se
        JOIN `tabDiseases Scouting Entry` d ON d.parent = se.name
        WHERE {where}
    """, params, as_dict=True)

    publish_progress(job_id, 70, "loading trap rows")
    traps = frappe.db.sql(f"""
        SELECT se.name, se.date_of_capture, t.pest, t.count
        FROM `tabScouting Entry` se
        JOIN `tabTrap Scouting Entry` t ON t.parent = se.name
        WHERE {where}
    """, params, as_dict=True)

    publish_progress(job_id, 85, "counting scouts")
    scout_rows = frappe.db.sql(f"""
        SELECT DISTINCT scouts_name FROM `tabScouting Entry` se WHERE {where}
    """, params, as_dict=True)

    pest_map = {}
    disease_map = {}
    trap_map = {}
    daily = {}
    alerts = 0
    # (kind, obs_name, stage) → set of zones, single greenhouse.
    cells: dict = {}

    for r in pests:
        n = int(r.count or 0)
        pest_map[r.pest] = pest_map.get(r.pest, 0) + (n if n else 1)
        d = str(r.date_of_capture)[:10]
        daily.setdefault(d, {"date": d, "pests": 0, "diseases": 0, "traps": 0})["pests"] += 1
        zone = (r.zone or "").strip()
        if zone:
            cells.setdefault(
                ("pest", r.pest or "", (r.stage or "").strip()), set(),
            ).add(zone)

    for r in diseases:
        disease_map[r.disease] = disease_map.get(r.disease, 0) + 1
        d = str(r.date_of_capture)[:10]
        daily.setdefault(d, {"date": d, "pests": 0, "diseases": 0, "traps": 0})["diseases"] += 1
        zone = (r.zone or "").strip()
        if zone:
            cells.setdefault(
                ("disease", r.disease or "", (r.stage or "").strip()), set(),
            ).add(zone)

    for r in traps:
        pname = r.pest or "Unknown"
        trap_map[pname] = trap_map.get(pname, 0) + int(r.count or 0)
        d = str(r.date_of_capture)[:10]
        daily.setdefault(d, {"date": d, "pests": 0, "diseases": 0, "traps": 0})["traps"] += 1
        if (int(r.count or 0)) > 10:
            alerts += 1

    # Pest + disease alerts now come from % of zones in THIS greenhouse
    # against the per-stage thresholds (with aggregate fallback) on
    # Crop Scouted. Traps stay count-based until trap thresholds get
    # the same treatment.
    zones_by_gh = scouting_metrics.get_zone_counts_by_greenhouse() or {}
    total_zones = zones_by_gh.get(filters["greenhouse"]) or 0
    if total_zones > 0:
        for (kind, obs_name, stage), zones in cells.items():
            pct = len(zones) / total_zones * 100
            sev = severity_for(filters["crop"], kind, obs_name, stage, pct)
            if sev == "high":
                alerts += 1

    def _top(d, n=6):
        # d is keyed by name, so it's a total-order tie-break.
        return sorted(
            [{"name": k, "count": v} for k, v in d.items()],
            key=lambda x: (-x["count"], x["name"]),
        )[:n]

    payload = {
        "topPests":    _top(pest_map),
        "topDiseases": _top(disease_map),
        "traps":       sorted(
            [{"pest": k, "total": v} for k, v in trap_map.items()],
            key=lambda x: (-x["total"], x["pest"]),
        )[:6],
        "daily": sorted(daily.values(), key=lambda x: x["date"]),
        "scouts": len({(r.scouts_name or "").strip() for r in scout_rows
                       if (r.scouts_name or "").strip()}),
        "alerts": alerts,
    }
    publish_progress(job_id, 100, "")
    return payload
