"""Pests and Diseases tabs aggregator (shared)."""

import frappe

from upande_scp.serverscripts import scouting_metrics
from upande_scp.serverscripts.scouting_metrics import get_zone_counts_by_greenhouse
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

    zones_by_gh = get_zone_counts_by_greenhouse() or {}

    ranking = _ranking(kind, rows)
    fo = _filter_options(rows)
    fo[kind + "s"] = fo.pop("items")

    return {
        "filterOptions":      fo,
        "ranking":             ranking,
        "distribution":       _distribution(rows, filters, zones_by_gh),
        "sectionSplit":       _section_split(rows, filters),
        "greenhousePressure": _gh_pressure(rows, filters, zones_by_gh),
        "dailyPercent":       _daily_percent(rows, filters, zones_by_gh),
        "trendSeries":        _trend_series(rows, kind),
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


# ---------------------------------------------------------------------------
# Zone-percent helpers (T10)
# ---------------------------------------------------------------------------

def _zone_key(row) -> str:
    """Mirror aggregate.ts uniqueZoneKey."""
    if row.block:
        return f"{row.block}::tree::{row.tree or ''}"
    if row.zone:
        return f"zone::{row.zone}"
    if row.bed:
        return f"bed::{row.bed}"
    return ""


def _filter_row(row, filters: dict) -> bool:
    """Apply observation/section/stage filters to a single child row."""
    if filters["observation"] and row.obs_name != filters["observation"]:
        return False
    if filters["section"] and row.plant_section != filters["section"]:
        return False
    if filters["stage"] and (row.stage or "") != filters["stage"]:
        return False
    return True


def _distribution(rows, filters, zones_by_gh) -> list:
    """% of total zones in scope that have each observation type."""
    ghs_in_scope = {r.greenhouse or r.block for r in rows
                    if (r.greenhouse or r.block)}
    denom = max(1, sum(zones_by_gh.get(gh, 0) for gh in ghs_in_scope))
    by_obs = {}
    for r in rows:
        if not _filter_row(r, {**filters, "observation": ""}):
            continue
        u = _zone_key(r)
        if not u:
            continue
        by_obs.setdefault(r.obs_name, set()).add(u)
    out = [{"name": n, "zones": len(s),
            "pct": round(len(s) / denom * 1000) / 10}
           for n, s in by_obs.items()]
    out.sort(key=lambda x: x["zones"], reverse=True)
    return out


def _section_split(rows, filters) -> list:
    sections = {}
    for r in rows:
        if filters["observation"] and r.obs_name != filters["observation"]:
            continue
        if filters["stage"] and (r.stage or "") != filters["stage"]:
            continue
        sec = (r.plant_section or "Unknown").strip() or "Unknown"
        u = _zone_key(r)
        if not u:
            continue
        sections.setdefault(sec, set()).add(u)
    total = max(1, sum(len(s) for s in sections.values()))
    out = [{"name": n, "zones": len(s),
            "pct": round(len(s) / total * 1000) / 10}
           for n, s in sections.items()]
    out.sort(key=lambda x: x["zones"], reverse=True)
    return out


def _gh_pressure(rows, filters, zones_by_gh) -> list:
    gh_to_zones = {}
    for r in rows:
        if not _filter_row(r, filters):
            continue
        gh = r.greenhouse or r.block
        if not gh:
            continue
        u = _zone_key(r)
        if not u:
            continue
        gh_to_zones.setdefault(gh, set()).add(u)
    out = [{"name": gh, "zones": len(s),
            "pct": round(len(s) / max(1, zones_by_gh.get(gh, 0)) * 1000) / 10}
           for gh, s in gh_to_zones.items()]
    out.sort(key=lambda x: x["pct"], reverse=True)
    return out


def _daily_percent(rows, filters, zones_by_gh) -> list:
    ghs = {r.greenhouse or r.block for r in rows if (r.greenhouse or r.block)}
    denom = max(1, sum(zones_by_gh.get(gh, 0) for gh in ghs))
    by_date = {}
    by_entry = {}
    for r in rows:
        if not _filter_row(r, filters):
            continue
        u = _zone_key(r)
        if not u:
            continue
        date = str(r.date_of_capture)[:10]
        if by_entry.get((date, r.name)) == u:
            continue
        by_entry[(date, r.name)] = u
        by_date.setdefault(date, set()).add(u)
    out = [{"date": d, "value": round(len(s) / denom * 1000) / 10}
           for d, s in by_date.items()]
    out.sort(key=lambda x: x["date"])
    return out


def _trend_series(rows, kind: str, top_n: int = 5) -> dict:
    """One row per date, one key per top-N observation, value = sum of count
    (pest) or 1-per-row (disease)."""
    pairs = {}
    for r in rows:
        bucket = pairs.setdefault(r.obs_name, {"name": r.obs_name, "total": 0,
                                                "daily": {}})
        date = str(r.date_of_capture)[:10]
        v = int(r.count or 0) if kind == "pest" else 1
        bucket["daily"][date] = bucket["daily"].get(date, 0) + v
        bucket["total"] += v
    top = sorted(pairs.values(), key=lambda x: x["total"], reverse=True)[:top_n]
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
