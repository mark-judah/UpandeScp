"""Data quality tab aggregator (roadmap item 7, spec 2026-10-10-data-quality-design).

One scan of the scoped Scouting Entries, read one capture date at a time
(newest first) and folded by ``common/quality_rules.Fold``:

* the entry columns the KPIs need, the fix-to-zone distance from the 1:1
  Scouting Entry Metadata row (LEFT JOIN on its ``scouting_entry`` index), and
  "nothing found" as NOT EXISTS on the pest and disease child tables;
* station coverage and sections for each house's latest ISO week through piece
  2's ``StationWeeks`` / ``prevalence.figures`` — fed the stations this scan
  already read, so no second pass over the entries.

Why per-day rows into a fold rather than one GROUP BY: measured on kaitet.local
(Rose, 4 weeks, 519k entries) the grouped form — a LAG() derived table grouped
by scout/day/house, plus GROUP BYs for duplicates, the distance histogram and the
sync-delay median — costs 12.2 s + 9.8 s + 4.5 s + 1.6 s, because each is its own
pass over half a million rows. A single pass reading the same rows is 6.8 s, and
the Python fold over it ~1 s. Reading per date keeps the worker's memory to one
day's rows (~20k) and gives the progress bar a real figure.
"""

from datetime import datetime, timedelta

import frappe

from upande_scp.serverscripts.common import quality_rules as Q
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    parent_filter_conditions,
    publish_progress,
    resolve_greenhouse_scope,
)
from upande_scp.serverscripts.scouting import scouting_metrics

_ROWS = f"""
SELECT se.scouts_name, se.date_of_capture, {R._WH}, COALESCE({R._STATION}, ''),
       COALESCE(NULLIF(se.`row`, ''), se.bed),
       TIME_TO_SEC(se.time_of_capture),
       IF(se.creation >= %(sync_from)s,
          TIMESTAMPDIFF(SECOND, TIMESTAMP(se.date_of_capture, se.time_of_capture), se.creation),
          NULL),
       m.distance, m.zone_buffer,
       (NOT EXISTS (SELECT 1 FROM `tabPests Scouting Entry` p WHERE p.parent = se.name)
        AND NOT EXISTS (SELECT 1 FROM `tabDiseases Scouting Entry` d WHERE d.parent = se.name))
FROM `tabScouting Entry` se
LEFT JOIN `tabScouting Entry Metadata` m ON m.scouting_entry = se.name
WHERE {{where}}
"""


def quality(args: dict, force: bool = False) -> dict:
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
        "quality", filters, lambda: _build(filters, scope, job_id), force=force,
    )


def _days_desc(from_date: str, to_date: str) -> list:
    """Every date in the window, newest first; [] for a missing or inverted range."""
    try:
        start = datetime.strptime(str(from_date)[:10], "%Y-%m-%d").date()
        end = datetime.strptime(str(to_date)[:10], "%Y-%m-%d").date()
    except ValueError:
        return []
    out = []
    while end >= start:
        out.append(end.isoformat())
        end -= timedelta(days=1)
    return out


def _yearweek(day) -> int:
    iso = day.isocalendar()
    return iso[0] * 100 + iso[1]


def _build(filters: dict, scope, job_id: str = "") -> dict:
    publish_progress(job_id, 5, "resolving filters")
    days = _days_desc(filters["from_date"], filters["to_date"])
    where, params = parent_filter_conditions(
        filters["from_date"], filters["to_date"], filters["crop"], scope,
    )
    fold = Q.Fold()
    latest: dict = {}  # house -> (yearweek, {station}) for its newest week in the window
    if where != "1=0":
        sql = _ROWS.format(where=where)
        for i, day in enumerate(days):
            publish_progress(job_id, 5 + (80 * i) // max(len(days), 1), f"reading {day}")
            rows = frappe.db.sql(sql, {**params, "from_date": day, "to_date": day,
                                       "sync_from": Q.SYNC_DELAY_FROM})
            if not rows:
                continue
            fold.add_day(rows)
            _note_stations(latest, rows)

    publish_progress(job_id, 88, "station coverage")
    coverage = _coverage(latest)
    houses = fold.house_rows(coverage)
    scouts = fold.scout_rows(_scout_names(list(fold.scouts)))
    kpis = fold.kpis(list(coverage.values()))
    publish_progress(job_id, 100, "")
    return {
        "kpis": kpis,
        "flags": Q.flag_rows(houses, scouts, kpis["nothingFoundPct"]),
        "houses": houses,
        "scouts": scouts,
        "thresholds": _thresholds(),
    }


def _note_stations(latest: dict, rows) -> None:
    """Days arrive newest first, so the first week seen for a house is its
    latest; stations from an older week are ignored."""
    for _s, day, wh, station, *_rest in rows:
        if not wh or not station:
            continue
        yw = _yearweek(day)
        cur = latest.get(wh)
        if cur is None:
            latest[wh] = (yw, {station})
        elif cur[0] == yw:
            cur[1].add(station)


def _coverage(latest: dict) -> dict:
    """``{house: prevalence figure}`` for each house's latest week — stations,
    scouted (in its grid), coverage %, sections scouted — via ``StationWeeks``."""
    if not latest:
        return {}
    R.prefetch_grids(latest)
    weeks = R.StationWeeks(
        [{"wh": wh, "station": st, "yw": yw, "in_win": 1}
         for wh, (yw, stations) in latest.items() for st in stations],
        [],
    )
    out = {}
    for wh in weeks.warehouses():
        week, _prev = weeks.latest_pair(wh)
        fig = weeks.figures(wh, week, "pest") if week else None
        if fig:
            out[wh] = {
                "week": week,
                "stations": fig.get("stations"),
                "scouted": fig.get("scouted"),
                "coverage": fig.get("coverage"),
                "sections_scouted": fig.get("sections_scouted"),
            }
    return out


def _scout_names(ids: list) -> dict:
    if not ids:
        return {}
    return {
        r.name: r.employee_name
        for r in frappe.get_all("Employee", filters={"name": ["in", ids]},
                                fields=["name", "employee_name"], limit_page_length=0)
    }


def _thresholds() -> dict:
    """The Q4 lines, so the tab can say what each flag means."""
    return {
        "mapOffsetMedianM": Q.MAP_OFFSET_MEDIAN_M,
        "minFixes": Q.MIN_FIXES,
        "thinCoveragePct": Q.THIN_COVERAGE_PCT,
        "tooFastPct": Q.TOO_FAST_PCT,
        "tooFastSeconds": Q.TOO_FAST_SECONDS,
        "nothingFoundExcess": Q.NOTHING_FOUND_EXCESS,
        "nothingFoundMinEntries": Q.NOTHING_FOUND_MIN_ENTRIES,
        "offZonePct": Q.OFF_ZONE_PCT,
        "duplicatePct": Q.DUPLICATE_PCT,
        "metadataMinPct": Q.METADATA_MIN_PCT,
        "syncDelayFrom": Q.SYNC_DELAY_FROM,
    }
