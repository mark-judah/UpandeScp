"""Pests and Diseases tabs aggregator (shared)."""

import frappe

from upande_scp.serverscripts import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    disease_severity,
    parent_filter_conditions,
    pest_severity,
    resolve_greenhouse_scope,
)


def pests(args: dict, force: bool = False) -> dict:
    return _build_endpoint("pest", args, force)


def diseases(args: dict, force: bool = False) -> dict:
    return _build_endpoint("disease", args, force)


_TABLE = {
    "pest":    ("tabPests Scouting Entry",    "pest"),
    "disease": ("tabDiseases Scouting Entry", "disease"),
}


def _build_endpoint(kind: str, args: dict, force: bool) -> dict:
    farms_map = scouting_metrics.get_farms_and_warehouses() or {}
    scope = resolve_greenhouse_scope(
        (args.get("greenhouse") or "").strip(),
        (args.get("farm") or "").strip(),
        farms_map,
    )
    filters = {
        "kind": kind,
        "from_date": args.get("from_date", ""),
        "to_date":   args.get("to_date", ""),
        "crop":      (args.get("crop") or "").strip(),
        "farm":      (args.get("farm") or "").strip(),
        "greenhouse":(args.get("greenhouse") or "").strip(),
        "observation":(args.get("observation") or "").strip(),
        "section":   (args.get("section") or "").strip(),
        "stage":     (args.get("stage") or "").strip(),
    }
    return cached_aggregate(
        kind + "s",
        filters,
        lambda: _build(kind, filters, scope),
        force=force,
    )


def _build(kind: str, filters: dict, scope) -> dict:
    where, params = parent_filter_conditions(
        filters["from_date"], filters["to_date"], filters["crop"], scope,
    )
    table, col = _TABLE[kind]
    count_clause = "c.count AS count" if kind == "pest" else "NULL AS count"
    rows = frappe.db.sql(
        f"""
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               se.zone, se.bed, se.tree,
               c.{col} AS obs_name, c.plant_section AS plant_section,
               c.stage AS stage,
               {count_clause}
        FROM `tabScouting Entry` se
        JOIN `{table}` c ON c.parent = se.name
        WHERE {where}
        """,
        params,
        as_dict=True,
    )

    ranking = _ranking(kind, rows)
    fo = _filter_options(rows)
    fo[kind + "s"] = fo.pop("items")

    return {
        "filterOptions":      fo,
        "ranking":             ranking,
        "distribution":       [],   # T10
        "sectionSplit":       [],   # T10
        "greenhousePressure": [],   # T10
        "dailyPercent":       [],   # T10
        "trendSeries":        {"rows": [], "keys": []},  # T10
    }


def _ranking(kind: str, rows: list) -> list:
    by_name = {}
    for r in rows:
        bucket = by_name.setdefault(r.obs_name,
                                    {"name": r.obs_name, "total": 0,
                                     "high": 0, "moderate": 0, "low": 0})
        if kind == "pest":
            n = int(r.count or 0)
            bucket["total"] += n
            sev = pest_severity(n)
            bucket["high" if sev == "high" else
                   "moderate" if sev == "moderate" else
                   "low"] += 1
        else:
            bucket["total"] += 1
            sev = disease_severity(r.stage)
            bucket["high" if sev == "high" else
                   "moderate" if sev == "moderate" else
                   "low"] += 1
    return sorted(by_name.values(), key=lambda x: x["total"], reverse=True)


def _filter_options(rows: list) -> dict:
    """Returns a dict with key 'items' (kind-agnostic). The caller renames
    'items' -> 'pests' or 'diseases' depending on the kind so the JS-facing
    contract matches the existing client expectations."""
    obs       = sorted({r.obs_name for r in rows if r.obs_name})
    sections  = sorted({r.plant_section for r in rows if r.plant_section})
    stages    = sorted({(r.stage or "") for r in rows if (r.stage or "")})
    return {"items": obs, "sections": sections, "stages": stages}
