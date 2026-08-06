"""FCM tab aggregator — pulls trap + pest rows whose names match the focus
regex /fcm|moth|codling|tortrix|noctuid/i."""

import re

import frappe

from upande_scp.serverscripts.scouting import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    parent_filter_conditions,
    publish_progress,
    resolve_greenhouse_scope,
)


_FOCUS_RE = re.compile(r"fcm|moth|codling|tortrix|noctuid", re.IGNORECASE)


def fcm(args: dict, force: bool = False) -> dict:
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
        "fcm", filters, lambda: _build(filters, scope, job_id), force=force,
    )


def _build(filters: dict, scope, job_id: str = "") -> dict:
    publish_progress(job_id, 5, "resolving filters")
    where, params = parent_filter_conditions(
        filters["from_date"], filters["to_date"], filters["crop"], scope,
    )

    publish_progress(job_id, 25, "loading pest rows")
    pests = frappe.db.sql(
        f"""
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               se.zone,
               p.pest, p.count
        FROM `tabScouting Entry` se
        JOIN `tabPests Scouting Entry` p ON p.parent = se.name
        WHERE {where}
        """,
        params,
        as_dict=True,
    )
    publish_progress(job_id, 60, "loading trap rows")
    traps = frappe.db.sql(
        f"""
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               t.trap, t.pest, t.count
        FROM `tabScouting Entry` se
        JOIN `tabTrap Scouting Entry` t ON t.parent = se.name
        WHERE {where}
        """,
        params,
        as_dict=True,
    )

    publish_progress(job_id, 85, "filtering focus pests")
    focus_pests = [r for r in pests if _FOCUS_RE.search(r.pest or "")]
    focus_traps = [r for r in traps if _FOCUS_RE.search(r.pest or "")]

    trap_total = sum(int(r.count or 0) for r in focus_traps)
    pest_total = sum(int(r.count or 0) for r in focus_pests)
    zones = {r.zone for r in focus_pests if r.zone}
    ghs = {(r.greenhouse or r.block) for r in focus_traps if (r.greenhouse or r.block)}

    daily = {}
    for r in focus_traps:
        d = str(r.date_of_capture)[:10]
        b = daily.setdefault(d, {"date": d, "traps": 0, "scouting": 0})
        b["traps"] += int(r.count or 0)
    for r in focus_pests:
        d = str(r.date_of_capture)[:10]
        b = daily.setdefault(d, {"date": d, "traps": 0, "scouting": 0})
        b["scouting"] += int(r.count or 0)

    breakdown = {}
    for r in focus_traps:
        breakdown[r.pest] = breakdown.get(r.pest, 0) + int(r.count or 0)

    focus_pest_totals = {}
    for r in focus_pests:
        focus_pest_totals[r.pest] = focus_pest_totals.get(r.pest, 0) + int(r.count or 0)

    payload = {
        "kpis": {
            "trapTotal":       trap_total,
            "pestTotal":       pest_total,
            "focusZones":      len(zones),
            "greenhouseCount": len(ghs),
        },
        "daily":         sorted(daily.values(), key=lambda x: x["date"]),
        # breakdown / focus_pest_totals are keyed by pest name, so it's a
        # total-order tie-break.
        "pestBreakdown": sorted(
            [{"name": n, "value": v} for n, v in breakdown.items()],
            key=lambda x: (-x["value"], x["name"]),
        ),
        "focusPests":    sorted(
            [{"name": n, "total": v} for n, v in focus_pest_totals.items()],
            key=lambda x: (-x["total"], x["name"]),
        )[:10],
    }
    publish_progress(job_id, 100, "")
    return payload
