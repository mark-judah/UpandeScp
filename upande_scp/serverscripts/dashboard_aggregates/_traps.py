"""Traps tab aggregator."""

import re
import frappe

from upande_scp.serverscripts.scouting import scouting_metrics

_FCM_RE = re.compile(r"fcm|moth", re.IGNORECASE)
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    parent_filter_conditions,
    publish_progress,
    resolve_greenhouse_scope,
)


def traps(args: dict, force: bool = False) -> dict:
    farms_map = scouting_metrics.get_farms_and_warehouses() or {}
    scope = resolve_greenhouse_scope(
        (args.get("greenhouse") or "").strip(),
        (args.get("farm") or "").strip(),
        farms_map,
    )
    job_id = (args.get("job_id") or "").strip()
    filters = {
        "from_date": args.get("from_date", ""),
        "to_date":   args.get("to_date", ""),
        "crop":      (args.get("crop") or "").strip(),
        "farm":      (args.get("farm") or "").strip(),
        "greenhouse":(args.get("greenhouse") or "").strip(),
    }
    return cached_aggregate(
        "traps", filters, lambda: _build(filters, scope, job_id), force=force,
    )


def _build(filters: dict, scope, job_id: str = "") -> dict:
    publish_progress(job_id, 10, "resolving filters")
    where, params = parent_filter_conditions(
        filters["from_date"], filters["to_date"], filters["crop"], scope,
    )
    publish_progress(job_id, 30, "loading trap rows")
    rows = frappe.db.sql(
        f"""
        SELECT STRAIGHT_JOIN se.name, se.date_of_capture, se.greenhouse, se.block,
               t.trap, t.pest, t.location, t.count
        FROM `tabScouting Entry` se
        JOIN `tabTrap Scouting Entry` t ON t.parent = se.name
        WHERE {where}
        """,
        params,
        as_dict=True,
    )

    publish_progress(job_id, 80, "summarising catches")
    payload = {
        "kpis":          _kpis(rows),
        "ranking":       _ranking(rows),
        "pestBreakdown": _pest_breakdown(rows),
        "trendSeries":   _trend_series(rows),
    }
    publish_progress(job_id, 100, "")
    return payload


def _ranking(rows: list) -> list:
    by_key = {}
    for r in rows:
        k = f"{r.trap}-{r.pest}"
        b = by_key.setdefault(k, {"key": k, "trap": r.trap, "pest": r.pest,
                                  "total": 0, "_count": 0})
        b["total"] += int(r.count or 0)
        b["_count"] += 1
    out = []
    for b in by_key.values():
        avg = round(b["total"] / b["_count"]) if b["_count"] else 0
        out.append({"key": b["key"], "trap": b["trap"], "pest": b["pest"],
                    "total": b["total"], "avg": avg})
    # by_key is keyed by "{trap}-{pest}", so it's a total-order tie-break.
    out.sort(key=lambda x: (-x["total"], x["key"]))
    return out


def _pest_breakdown(rows: list) -> list:
    by_pest = {}
    for r in rows:
        by_pest[r.pest] = by_pest.get(r.pest, 0) + int(r.count or 0)
    # by_pest is keyed by pest name, so it's a total-order tie-break.
    return sorted(
        [{"name": k, "value": v} for k, v in by_pest.items()],
        key=lambda x: (-x["value"], x["name"]),
    )


def _trend_series(rows: list, top_n: int = 5) -> dict:
    by_pest = {}
    for r in rows:
        p = by_pest.setdefault(r.pest, {"name": r.pest, "total": 0, "daily": {}})
        v = int(r.count or 0)
        d = str(r.date_of_capture)[:10]
        p["daily"][d] = p["daily"].get(d, 0) + v
        p["total"] += v
    # by_pest is keyed by pest name, so it's a total-order tie-break.
    top = sorted(by_pest.values(), key=lambda x: (-x["total"], x["name"]))[:top_n]
    if not top:
        return {"rows": [], "keys": []}
    dates = sorted({d for p in top for d in p["daily"]})
    keys = [p["name"] for p in top]
    out_rows = []
    for d in dates:
        row = {"date": d}
        for p in top:
            row[p["name"]] = p["daily"].get(d, 0)
        out_rows.append(row)
    return {"rows": out_rows, "keys": keys}


def _kpis(rows: list) -> dict:
    """KPIs the TrapsTab grid displays:
       trapZones    — distinct greenhouses (or block fallback) with any trap row
       activeTraps  — distinct trap-name values
       fcmCount     — total catches whose pest matches /fcm|moth/i
       totalCatches — total catches across all rows
    """
    ghs = set()
    trap_names = set()
    fcm = 0
    total = 0
    for r in rows:
        gh = r.greenhouse or r.block
        if gh:
            ghs.add(gh)
        if r.trap:
            trap_names.add(r.trap)
        c = int(r.count or 0)
        total += c
        if _FCM_RE.search(r.pest or ""):
            fcm += c
    return {
        "trapZones":    len(ghs),
        "activeTraps":  len(trap_names),
        "fcmCount":     fcm,
        "totalCatches": total,
    }
