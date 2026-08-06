"""Heatmap rendering POC — single-greenhouse, single-observation endpoint
that returns the last three scouting dates with per-zone observation counts.

Deliberately minimal: no farm/crop filter, no progress events, no force flag.
Throwaway slice used to measure the bed-line-with-instanced-markers rendering
approach. If it pans out, the full Heatmaps migration spec replaces this
with a card-grid endpoint that follows the same shape.
"""

import frappe

from upande_scp.serverscripts.scouting.get_complete_scouting_entries import (
    _cached_disease_colors,
    _cached_pest_colors,
)
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    stage_icon_map,
)


_KIND_TABLE = {
    "pest":    ("tabPests Scouting Entry",     "pest",    "pests_legend_color"),
    "disease": ("tabDiseases Scouting Entry", "disease", "disease_legend_color"),
}


def heatmap_poc(args: dict, force: bool = False) -> dict:
    greenhouse = (args.get("greenhouse") or "").strip()
    obs_name = (args.get("obs_name") or "").strip()
    obs_kind = (args.get("obs_kind") or "pest").strip().lower()
    if obs_kind not in _KIND_TABLE:
        obs_kind = "pest"

    if not greenhouse or not obs_name:
        return {"greenhouse": greenhouse, "obsName": obs_name, "obsKind": obs_kind,
                "color": "#888888", "recent": []}

    filters = {
        "greenhouse": greenhouse,
        "obs_name":   obs_name,
        "obs_kind":   obs_kind,
    }
    return cached_aggregate(
        "heatmap_poc",
        filters,
        lambda: _build(greenhouse, obs_name, obs_kind),
        force=force,
    )


def _build(greenhouse: str, obs_name: str, obs_kind: str) -> dict:
    table, col, color_field = _KIND_TABLE[obs_kind]

    # Color lookup — use the existing legend caches so a colour change in the
    # Pest / Plant Disease doctype propagates here without our own invalidation.
    if obs_kind == "pest":
        color_rows = _cached_pest_colors()
    else:
        color_rows = _cached_disease_colors()
    color = next(
        (r.get(color_field) for r in color_rows if r.get("name") == obs_name),
        None,
    ) or "#888888"

    # Step 1: most-recent 3 distinct dates this (greenhouse, obs) has been
    # scouted within the rolling 90-day window. Keeping the date list tight
    # before the per-zone join keeps the GROUP BY cheap on a busy table.
    date_rows = frappe.db.sql(
        f"""
        SELECT DISTINCT se.date_of_capture
        FROM `tabScouting Entry` se
        JOIN `{table}` c ON c.parent = se.name
        WHERE (se.greenhouse = %(gh)s OR se.block = %(gh)s)
          AND c.{col} = %(obs)s
          AND se.date_of_capture >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
        ORDER BY se.date_of_capture DESC
        LIMIT 3
        """,
        {"gh": greenhouse, "obs": obs_name},
        as_dict=True,
    )
    dates = [str(r["date_of_capture"])[:10] for r in date_rows if r.get("date_of_capture")]
    if not dates:
        return {"greenhouse": greenhouse, "obsName": obs_name, "obsKind": obs_kind,
                "color": color, "recent": []}

    # Step 2: per-zone, per-stage counts for each of those three dates.
    zone_rows = frappe.db.sql(
        f"""
        SELECT DATE_FORMAT(se.date_of_capture, '%%Y-%%m-%%d') AS d,
               se.zone,
               c.stage AS stage,
               COUNT(*) AS n
        FROM `tabScouting Entry` se
        JOIN `{table}` c ON c.parent = se.name
        WHERE (se.greenhouse = %(gh)s OR se.block = %(gh)s)
          AND c.{col} = %(obs)s
          AND se.date_of_capture IN %(dates)s
          AND se.zone IS NOT NULL AND se.zone != ''
        GROUP BY se.date_of_capture, se.zone, c.stage
        """,
        {"gh": greenhouse, "obs": obs_name, "dates": tuple(dates)},
        as_dict=True,
    )

    icons = stage_icon_map()

    # Bucket per date: zoneObs = {zone: total count} (unchanged),
    # zoneStages = {zone: [{stage, icon_key, count}]} for stage-shaped markers.
    by_date = {d: {} for d in dates}
    by_date_stages = {d: {} for d in dates}
    for r in zone_rows:
        d = r["d"]
        if d not in by_date:
            continue
        zone = r["zone"]
        n = int(r["n"] or 0)
        by_date[d][zone] = by_date[d].get(zone, 0) + n
        stage = (r.get("stage") or "").strip()
        by_date_stages[d].setdefault(zone, []).append({
            "stage": stage,
            "icon_key": icons.get(stage, ""),
            "count": n,
        })

    # zone_rows is GROUP BY (date, zone, stage) with no ORDER BY, so each
    # per-zone stage list was appended in scan order. Each (date, zone)
    # bucket has at most one entry per stage, so sorting by stage alone
    # gives a total order.
    for zones in by_date_stages.values():
        for zone_stages in zones.values():
            zone_stages.sort(key=lambda s: s["stage"])

    recent = [
        {"date": d, "zoneObs": by_date[d], "zoneStages": by_date_stages[d]}
        for d in dates
    ]
    return {"greenhouse": greenhouse, "obsName": obs_name, "obsKind": obs_kind,
            "color": color, "recent": recent}
