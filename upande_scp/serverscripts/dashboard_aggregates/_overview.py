"""Overview tab aggregator."""

import frappe

from upande_scp.serverscripts import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    parent_filter_conditions,
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

    farms_map = scouting_metrics.get_farms_and_warehouses() or {}
    scope = resolve_greenhouse_scope(gh, farm, farms_map)

    cache_filters = {
        "from_date": from_date, "to_date": to_date,
        "crop": crop, "farm": farm, "greenhouse": gh,
    }
    return cached_aggregate(
        "overview",
        cache_filters,
        lambda: _build(from_date, to_date, crop, scope),
        force=force,
    )


def _build(from_date, to_date, crop, scope) -> dict:
    where, params = parent_filter_conditions(from_date, to_date, crop, scope)

    kpis = _kpis(where, params)

    return {
        "kpis": kpis,
        "daily": [],            # next steps fill these
        "rangeTotals": {"pests": 0, "diseases": 0, "traps": 0},
        "ghHealth": [],
        "topScouts": [],
        "scoutsPerDay": [],
        "scoutPerformance": [],
        "recentActivity": [],
        "activeAlerts": [],
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
        "highAlerts":      0,  # set in Task 7 alongside ghHealth
    }
