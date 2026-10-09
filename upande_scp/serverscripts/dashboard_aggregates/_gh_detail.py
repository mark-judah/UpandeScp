"""Greenhouse drill-down used by GreenhouseModal."""

import frappe

from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    obs_filter,
    parent_filter_conditions,
    publish_progress,
    severity_for,
)

#: How many of the top pests and of the top diseases get a 3 × 3 grid.
_GRID_TOP_N = 3


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
            "scouts": 0, "alerts": 0, "prevalence": []}


def _build(filters: dict, job_id: str = "") -> dict:
    publish_progress(job_id, 10, "resolving filters")
    where, params = parent_filter_conditions(
        filters["from_date"], filters["to_date"], filters["crop"],
        [filters["greenhouse"]],
    )

    pest_obs = obs_filter("pest", "p.pest", params)
    disease_obs = obs_filter("disease", "d.disease", params)

    publish_progress(job_id, 25, "loading pest rows")
    pests = frappe.db.sql(f"""
        SELECT se.name, se.date_of_capture, se.zone, se.tree, p.pest, p.stage, p.count
        FROM `tabScouting Entry` se
        JOIN `tabPests Scouting Entry` p ON p.parent = se.name
        WHERE {where}{pest_obs}
    """, params, as_dict=True)

    publish_progress(job_id, 50, "loading disease rows")
    diseases = frappe.db.sql(f"""
        SELECT se.name, se.date_of_capture, se.zone, se.tree, d.disease, d.stage
        FROM `tabScouting Entry` se
        JOIN `tabDiseases Scouting Entry` d ON d.parent = se.name
        WHERE {where}{disease_obs}
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

    publish_progress(job_id, 90, "loading scouted stations")
    weeks = _prevalence_rows.StationWeeks.load(
        filters["from_date"], filters["to_date"], filters["crop"], [filters["greenhouse"]],
    )

    pest_map = {}
    disease_map = {}
    trap_map = {}
    daily = {}
    alerts = 0
    # Stages seen per kind on a station (zone or tree) of this house.
    stages: dict = {"pest": set(), "disease": set()}

    for r in pests:
        n = int(r.count or 0)
        pest_map[r.pest] = pest_map.get(r.pest, 0) + (n if n else 1)
        d = str(r.date_of_capture)[:10]
        daily.setdefault(d, {"date": d, "pests": 0, "diseases": 0, "traps": 0})["pests"] += 1
        if (r.zone or r.tree or "").strip():
            stages["pest"].add((r.stage or "").strip())

    for r in diseases:
        disease_map[r.disease] = disease_map.get(r.disease, 0) + 1
        d = str(r.date_of_capture)[:10]
        daily.setdefault(d, {"date": d, "pests": 0, "diseases": 0, "traps": 0})["diseases"] += 1
        if (r.zone or r.tree or "").strip():
            stages["disease"].add((r.stage or "").strip())

    for r in traps:
        pname = r.pest or "Unknown"
        trap_map[pname] = trap_map.get(pname, 0) + int(r.count or 0)
        d = str(r.date_of_capture)[:10]
        daily.setdefault(d, {"date": d, "pests": 0, "diseases": 0, "traps": 0})["traps"] += 1
        if (int(r.count or 0)) > 10:
            alerts += 1

    # Pest + disease alerts come from this house's station prevalence in its
    # latest scouted ISO week (StationWeeks.latest_by_house) against the
    # per-stage thresholds (with aggregate fallback) on Crop Scouted. Traps stay
    # count-based until trap thresholds get the same treatment.
    gh = filters["greenhouse"]
    for kind in ("pest", "disease"):
        for stage in sorted(stages[kind]):
            for obs_name, fig in weeks.latest_by_house(kind, stage=stage).get(gh, {}).items():
                if fig["prevalence"] is None:
                    continue
                if severity_for(filters["crop"], kind, obs_name, stage, fig["prevalence"]) == "high":
                    alerts += 1

    def _top(d, n=6):
        # d is keyed by name, so it's a total-order tie-break.
        return sorted(
            [{"name": k, "count": v} for k, v in d.items()],
            key=lambda x: (-x["count"], x["name"]),
        )[:n]

    top_pests = _top(pest_map)
    top_diseases = _top(disease_map)

    # The 3 × 3 picture (spec §3) for the top observations, latest scouted week.
    prevalence_rows = []
    for kind, top in (("pest", top_pests), ("disease", top_diseases)):
        for t in top[:_GRID_TOP_N]:
            fig = weeks.latest(gh, kind, t["name"])
            if not fig:
                continue
            prevalence_rows.append({
                "kind": kind,
                "name": t["name"],
                **P.public(fig),
                "sections": fig.get("sections") or [],
            })

    payload = {
        "topPests":    top_pests,
        "topDiseases": top_diseases,
        "traps":       sorted(
            [{"pest": k, "total": v} for k, v in trap_map.items()],
            key=lambda x: (-x["total"], x["pest"]),
        )[:6],
        "daily": sorted(daily.values(), key=lambda x: x["date"]),
        "scouts": len({(r.scouts_name or "").strip() for r in scout_rows
                       if (r.scouts_name or "").strip()}),
        "alerts": alerts,
        "prevalence": prevalence_rows,
    }
    publish_progress(job_id, 100, "")
    return payload
