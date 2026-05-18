"""Heatmaps grid aggregator.

Single endpoint that returns every (greenhouse × pest|disease) card the
page renders for the given filter. One SQL pass groups by
``(greenhouse, obs_name, date_of_capture, zone)`` so the Python pass that
follows is linear in the result-row count.

The page used to fetch raw entries via ``useScouting`` and aggregate
client-side. At 250k+ entries that was unworkable — see
``docs/superpowers/specs/2026-05-18-heatmaps-bed-symbol-design.md``.
"""

import frappe

from upande_scp.serverscripts import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    parent_filter_conditions,
    publish_progress,
    resolve_greenhouse_scope,
)
from upande_scp.serverscripts.get_complete_scouting_entries import (
    _cached_disease_colors,
    _cached_pest_colors,
)


_KIND_TABLE = {
    "pest":    ("tabPests Scouting Entry",    "pest",    "pests_legend_color"),
    "disease": ("tabDiseases Scouting Entry", "disease", "disease_legend_color"),
}


def heatmaps_grid(args: dict, force: bool = False) -> dict:
    mode = (args.get("mode") or "pest").strip().lower()
    if mode not in _KIND_TABLE:
        mode = "pest"
    obs_name = (args.get("obs_name") or "").strip()
    job_id = (args.get("job_id") or "").strip()

    farms_map = scouting_metrics.get_farms_and_warehouses() or {}
    scope = resolve_greenhouse_scope(
        (args.get("greenhouse") or "").strip(),
        (args.get("farm") or "").strip(),
        farms_map,
    )

    filters = {
        "from_date":  args.get("from_date", ""),
        "to_date":    args.get("to_date", ""),
        "crop":       (args.get("crop") or "").strip(),
        "farm":       (args.get("farm") or "").strip(),
        "greenhouse": (args.get("greenhouse") or "").strip(),
        "mode":       mode,
        "obs_name":   obs_name,
    }
    return cached_aggregate(
        "heatmaps_grid",
        filters,
        lambda: _build(filters, scope, job_id),
        force=force,
    )


def _build(filters: dict, scope, job_id: str = "") -> dict:
    publish_progress(job_id, 5, "resolving filters")
    where, params = parent_filter_conditions(
        filters["from_date"], filters["to_date"], filters["crop"], scope,
    )
    mode = filters["mode"]
    table, col, color_field = _KIND_TABLE[mode]

    publish_progress(job_id, 20, f"counting {mode} observations")

    extra_where = ""
    if filters["obs_name"]:
        extra_where = f" AND c.{col} = %(obs_name)s"
        params["obs_name"] = filters["obs_name"]

    publish_progress(job_id, 35, f"loading {mode} rows")

    # One row per (greenhouse, obs_name, date, zone). The count column
    # is the SUM of child.count where present, otherwise the row-count.
    # Diseases don't carry a count, so we use COUNT(*) for them; pests
    # use SUM(COALESCE(c.count, 1)).
    if mode == "pest":
        count_expr = "SUM(GREATEST(COALESCE(c.`count`, 1), 1))"
    else:
        count_expr = "COUNT(*)"

    rows = frappe.db.sql(
        f"""
        SELECT
            COALESCE(NULLIF(se.greenhouse, ''), se.block)   AS greenhouse,
            c.{col}                                         AS obs_name,
            DATE_FORMAT(se.date_of_capture, '%%Y-%%m-%%d')  AS d,
            se.zone                                         AS zone,
            {count_expr}                                    AS n
        FROM `tabScouting Entry` se
        JOIN `{table}` c ON c.parent = se.name
        WHERE {where}
          AND se.zone IS NOT NULL AND se.zone != ''
          {extra_where}
        GROUP BY 1, 2, 3, 4
        """,
        params,
        as_dict=True,
    )

    publish_progress(job_id, 75, "building cards")
    color_rows = _cached_pest_colors() if mode == "pest" else _cached_disease_colors()
    color_map = {r["name"]: r.get(color_field) for r in color_rows if r.get("name")}

    cards = _build_cards(rows, mode, color_map)

    publish_progress(job_id, 100, "")
    return {"cards": cards}


def _build_cards(rows: list, mode: str, color_map: dict) -> list:
    """Walk the per-(gh, obs, date, zone) rows once; emit one card per
    (gh, obs) with aggregate totals + the 3 most-recent distinct dates."""
    # by_gh_obs[gh][obs] = {
    #   total: int, zones: set, by_date: { date: { zone: count, ... } }
    # }
    by_gh_obs: dict = {}
    for r in rows:
        gh = r.get("greenhouse") or ""
        obs = r.get("obs_name") or ""
        d = r.get("d") or ""
        z = r.get("zone") or ""
        n = int(r.get("n") or 0)
        if not gh or not obs or not z or n <= 0:
            continue
        by_obs = by_gh_obs.setdefault(gh, {})
        bucket = by_obs.setdefault(obs, {
            "total": 0, "zones": set(), "by_date": {},
        })
        bucket["total"] += n
        bucket["zones"].add(z)
        day = bucket["by_date"].setdefault(d, {})
        day[z] = day.get(z, 0) + n

    cards = []
    for gh, by_obs in by_gh_obs.items():
        for obs, bucket in by_obs.items():
            # 3 most-recent dates, ISO strings sort lexicographically.
            dates = sorted(bucket["by_date"].keys(), reverse=True)[:3]
            recent = [
                {"date": d, "zoneObs": bucket["by_date"][d]} for d in dates
            ]
            cards.append({
                "greenhouse":    gh,
                "obsName":       obs,
                "obsKind":       mode,
                "color":         color_map.get(obs) or "#888888",
                "totalObs":      bucket["total"],
                "zonesAffected": len(bucket["zones"]),
                "lastDate":      dates[0] if dates else "",
                "recent":        recent,
            })

    # Most-active first, then greenhouse / obs name for stable ordering.
    cards.sort(key=lambda c: (-c["totalObs"], c["greenhouse"], c["obsName"]))
    return cards
