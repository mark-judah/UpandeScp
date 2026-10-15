"""Weekly series behind the sparklines on the dashboard KPI cards.

One lightweight payload: for every card that counts something, the value per ISO
week (Monday-dated), over the selected range stretched back to at least
``MIN_WEEKS`` weeks so a short range still draws a trend. Grouped in SQL with
``YEARWEEK(date, 3)`` (ISO weeks), cached like the other aggregates.

Pest and disease series follow the crop only, not the tab's observation/section/
stage filters: they show the scope's trend, not the filtered cut.
"""

import datetime

import frappe

from upande_scp.serverscripts.scouting import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    coerce_date,
    obs_filter,
    parent_filter_conditions,
    resolve_greenhouse_scope,
)

MIN_WEEKS = 8

KEYS = (
    "scouts", "zones", "units",
    "pestKinds", "pests", "diseaseKinds", "diseases",
    "trapZones", "activeTraps", "fcm", "catches",
)


def kpi_series(args: dict, force: bool = False) -> dict:
    farms_map = scouting_metrics.get_farms_and_warehouses() or {}
    scope = resolve_greenhouse_scope(
        (args.get("greenhouse") or "").strip(),
        (args.get("farm") or "").strip(),
        farms_map,
    )
    filters = {
        "from_date": args.get("from_date", ""),
        "to_date":   args.get("to_date", ""),
        "crop":      (args.get("crop") or "").strip(),
        "farm":      (args.get("farm") or "").strip(),
        "greenhouse": (args.get("greenhouse") or "").strip(),
    }
    return cached_aggregate(
        "kpi_series", filters, lambda: _build(filters, scope), force=force,
    )


def _monday(d: datetime.date) -> datetime.date:
    return d - datetime.timedelta(days=d.weekday())


def week_starts(from_date: str, to_date: str) -> list:
    """Mondays covering [from, to], stretched back to at least MIN_WEEKS weeks."""
    end = _monday(datetime.date.fromisoformat(coerce_date(to_date) or datetime.date.today().isoformat()))
    start = _monday(datetime.date.fromisoformat(coerce_date(from_date))) if from_date else end
    start = min(start, end - datetime.timedelta(weeks=MIN_WEEKS - 1))
    out, cur = [], start
    while cur <= end:
        out.append(cur)
        cur += datetime.timedelta(weeks=1)
    return out


def _wk_key(d: datetime.date) -> int:
    y, w, _ = d.isocalendar()
    return y * 100 + w


def _build(filters: dict, scope) -> dict:
    mondays = week_starts(filters["from_date"], filters["to_date"])
    to_date = coerce_date(filters["to_date"]) or datetime.date.today().isoformat()
    where, params = parent_filter_conditions(
        mondays[0].isoformat(), to_date, filters["crop"], scope,
    )
    pest_obs = obs_filter("pest", "p.pest", params)
    disease_obs = obs_filter("disease", "d.disease", params)

    def run(sql):
        return {int(r.wk): r for r in frappe.db.sql(sql, params, as_dict=True)}

    entries = run(f"""
        SELECT YEARWEEK(se.date_of_capture, 3) AS wk,
               COUNT(DISTINCT se.scouts_name) AS scouts,
               COUNT(DISTINCT se.name) AS zones,
               COUNT(DISTINCT COALESCE(NULLIF(se.greenhouse, ''), NULLIF(se.block, ''))) AS units
        FROM `tabScouting Entry` se WHERE {where} GROUP BY wk""")
    pests = run(f"""
        SELECT YEARWEEK(se.date_of_capture, 3) AS wk,
               COUNT(*) AS n, COUNT(DISTINCT p.pest) AS kinds
        FROM `tabScouting Entry` se
        JOIN `tabPests Scouting Entry` p ON p.parent = se.name
        WHERE {where}{pest_obs} GROUP BY wk""")
    diseases = run(f"""
        SELECT YEARWEEK(se.date_of_capture, 3) AS wk,
               COUNT(*) AS n, COUNT(DISTINCT d.disease) AS kinds
        FROM `tabScouting Entry` se
        JOIN `tabDiseases Scouting Entry` d ON d.parent = se.name
        WHERE {where}{disease_obs} GROUP BY wk""")
    traps = run(f"""
        SELECT YEARWEEK(se.date_of_capture, 3) AS wk,
               COUNT(DISTINCT COALESCE(NULLIF(se.greenhouse, ''), NULLIF(se.block, ''))) AS zones,
               COUNT(DISTINCT t.trap) AS traps,
               COALESCE(SUM(t.count), 0) AS catches,
               COALESCE(SUM(CASE WHEN t.pest REGEXP 'fcm|moth' THEN t.count ELSE 0 END), 0) AS fcm
        FROM `tabScouting Entry` se
        JOIN `tabTrap Scouting Entry` t ON t.parent = se.name
        WHERE {where} GROUP BY wk""")

    def val(src, wk, col):
        r = src.get(wk)
        return int((r.get(col) if r else 0) or 0)

    series = {k: [] for k in KEYS}
    for m in mondays:
        wk, date = _wk_key(m), m.isoformat()
        week = f"{wk // 100}-W{wk % 100:02d}"
        point = lambda v: {"week": week, "date": date, "value": v}
        series["scouts"].append(point(val(entries, wk, "scouts")))
        series["zones"].append(point(val(entries, wk, "zones")))
        series["units"].append(point(val(entries, wk, "units")))
        series["pests"].append(point(val(pests, wk, "n")))
        series["pestKinds"].append(point(val(pests, wk, "kinds")))
        series["diseases"].append(point(val(diseases, wk, "n")))
        series["diseaseKinds"].append(point(val(diseases, wk, "kinds")))
        series["trapZones"].append(point(val(traps, wk, "zones")))
        series["activeTraps"].append(point(val(traps, wk, "traps")))
        series["catches"].append(point(val(traps, wk, "catches")))
        series["fcm"].append(point(val(traps, wk, "fcm")))
    return {"series": series}
