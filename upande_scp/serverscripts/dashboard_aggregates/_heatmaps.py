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

from upande_scp.serverscripts.scouting import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    parent_filter_conditions,
    publish_progress,
    resolve_greenhouse_scope,
    stage_icon_map,
)
from upande_scp.serverscripts.scouting.get_complete_scouting_entries import (
    _cached_disease_colors,
    _cached_pest_colors,
)


_KIND_TABLE = {
    "pest":    ("tabPests Scouting Entry",    "pest",    "pests_legend_color"),
    "disease": ("tabDiseases Scouting Entry", "disease", "disease_legend_color"),
}


def heatmaps_grid(args: dict, force: bool = False) -> dict:
    job_id = (args.get("job_id") or "").strip()

    farms_map = scouting_metrics.get_farms_and_warehouses() or {}

    # Greenhouse scope: prefer an explicit list of selections (the Trends-
    # style tristate picker sends an array); fall back to the single
    # ``greenhouse`` / ``farm`` form so older callers (and the smoke
    # tests) keep working.
    explicit = args.get("greenhouses")
    if isinstance(explicit, list) and explicit:
        scope = [str(g).strip() for g in explicit if str(g).strip()]
    else:
        scope = resolve_greenhouse_scope(
            (args.get("greenhouse") or "").strip(),
            (args.get("farm") or "").strip(),
            farms_map,
        )

    filters = {
        "from_date":   args.get("from_date", ""),
        "to_date":     args.get("to_date", ""),
        "crop":        (args.get("crop") or "").strip(),
        # Stash the scope (sorted) in the cache key so different greenhouse
        # selections don't collide.
        "scope_key":   "|".join(sorted(scope)) if isinstance(scope, list) else "",
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

    publish_progress(job_id, 25, "loading pest rows")
    pest_rows = _query_kind(where, params, "pest")

    publish_progress(job_id, 55, "loading disease rows")
    disease_rows = _query_kind(where, params, "disease")

    publish_progress(job_id, 80, "building cards")
    pest_colors = _cached_pest_colors()
    pest_color_map = {
        r["name"]: r.get("pests_legend_color")
        for r in pest_colors if r.get("name")
    }
    disease_colors = _cached_disease_colors()
    disease_color_map = {
        r["name"]: r.get("disease_legend_color")
        for r in disease_colors if r.get("name")
    }
    cards = _build_cards(pest_rows, "pest", pest_color_map)
    cards.extend(_build_cards(disease_rows, "disease", disease_color_map))
    # Most-active first across both kinds, then stable order. obsKind is
    # appended so a pest and a disease sharing a name in the same
    # greenhouse still resolve to a total order.
    cards.sort(key=lambda c: (-c["totalObs"], c["greenhouse"], c["obsName"], c["obsKind"]))

    publish_progress(job_id, 100, "")
    return {"cards": cards}


def _query_kind(where: str, params: dict, mode: str) -> list:
    """One SQL pass over the child table for ``mode``, grouped by
    (greenhouse, obs_name, date, zone)."""
    table, col, _color_field = _KIND_TABLE[mode]
    # Pests have a numeric count; diseases don't (one row = one
    # observation), so we sum-with-fallback for the former and
    # count rows for the latter.
    count_expr = (
        "SUM(GREATEST(COALESCE(c.`count`, 1), 1))"
        if mode == "pest"
        else "COUNT(*)"
    )
    return frappe.db.sql(
        f"""
        SELECT STRAIGHT_JOIN
            COALESCE(NULLIF(se.greenhouse, ''), se.block)   AS greenhouse,
            c.{col}                                         AS obs_name,
            DATE_FORMAT(se.date_of_capture, '%%Y-%%m-%%d')  AS d,
            se.zone                                         AS zone,
            c.stage                                         AS stage,
            {count_expr}                                    AS n
        FROM `tabScouting Entry` se
        JOIN `{table}` c ON c.parent = se.name
        WHERE {where}
          AND se.zone IS NOT NULL AND se.zone != ''
        GROUP BY 1, 2, 3, 4, 5
        """,
        params,
        as_dict=True,
    )


def _build_cards(rows: list, mode: str, color_map: dict) -> list:
    """Walk the per-(gh, obs, date, zone) rows once; emit one card per
    (gh, obs) with aggregate totals + the 3 most-recent distinct dates."""
    # by_gh_obs[gh][obs] = {
    #   total, zones: set,
    #   by_date: { date: { zone: count } },
    #   stages_by_date: { date: { zone: [{stage, icon_key, count}] } },
    # }
    icons = stage_icon_map()
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
            "total": 0, "zones": set(), "by_date": {}, "stages_by_date": {},
        })
        bucket["total"] += n
        bucket["zones"].add(z)
        day = bucket["by_date"].setdefault(d, {})
        day[z] = day.get(z, 0) + n
        stage = (r.get("stage") or "").strip()
        sday = bucket["stages_by_date"].setdefault(d, {})
        sday.setdefault(z, []).append({
            "stage": stage,
            "icon_key": icons.get(stage, ""),
            "count": n,
        })

    # _query_kind groups by (gh, obs, date, zone, stage) with no ORDER BY, so
    # each per-zone stage list was appended in scan order. Each (date, zone)
    # bucket has at most one entry per stage, so sorting by stage alone
    # gives a total order.
    for by_obs in by_gh_obs.values():
        for bucket in by_obs.values():
            for sday in bucket["stages_by_date"].values():
                for zone_stages in sday.values():
                    zone_stages.sort(key=lambda s: s["stage"])

    cards = []
    for gh, by_obs in by_gh_obs.items():
        for obs, bucket in by_obs.items():
            # 3 most-recent dates, ISO strings sort lexicographically.
            dates = sorted(bucket["by_date"].keys(), reverse=True)[:3]
            recent = [
                {
                    "date": d,
                    "zoneObs": bucket["by_date"][d],
                    "zoneStages": bucket["stages_by_date"].get(d, {}),
                }
                for d in dates
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
