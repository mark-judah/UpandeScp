"""Data quality tab aggregator (roadmap item 7, spec 2026-10-10-data-quality-design).

One scan of the scoped Scouting Entries, read one capture date at a time
(newest first) and folded by ``common/quality_rules.Fold``:

* the entry columns the KPIs need, the fix-to-zone distance from the 1:1
  Scouting Entry Metadata row (LEFT JOIN on its ``scouting_entry`` index), and
  "nothing found" as NOT EXISTS on the pest and disease child tables;
* station coverage and sections for each house's latest COMPLETE ISO week — the
  whole Monday–Sunday inside the range and already ended (C4, I1); a cut or
  unfinished week is used only when the range holds nothing else, and is then
  marked partial. A house whose week ended > 14 days before the range end is
  "not scouted recently" (I2) through piece 2's
  ``StationWeeks`` / ``prevalence.figures`` — fed the stations this scan already
  read, so no second pass over the entries.

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
from frappe.utils import getdate, nowdate

from upande_scp.serverscripts.common import quality_rules as Q
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    coerce_date,
    obs_filter,
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
       (NOT EXISTS (SELECT 1 FROM `tabPests Scouting Entry` p WHERE p.parent = se.name{{pest_obs}})
        AND NOT EXISTS (SELECT 1 FROM `tabDiseases Scouting Entry` d WHERE d.parent = se.name{{disease_obs}}))
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
    from_date, to_date, clamped = clamp_range(args.get("from_date", ""), args.get("to_date", ""))
    filters = {
        "from_date": from_date,
        "to_date":   to_date,
        "crop":      (args.get("crop") or "").strip(),
        "farm":      (args.get("farm") or "").strip(),
        "greenhouse":(args.get("greenhouse") or "").strip(),
    }
    payload = cached_aggregate(
        "quality", filters, lambda: _build(filters, scope, job_id), force=force,
    )
    return {**payload, "clamped": clamped, "range": {"from_date": from_date, "to_date": to_date}}


def clamp_range(from_date, to_date) -> tuple:
    """I3: ``(from, to, clamped)`` with ``from`` no earlier than ``to`` −
    ``MAX_RANGE_DAYS`` — the aggregate reads one query per day, so an unbounded
    window would outlive the request."""
    from_date, to_date = coerce_date(from_date), coerce_date(to_date)
    try:
        end = datetime.strptime(to_date, "%Y-%m-%d").date()
        start = datetime.strptime(from_date, "%Y-%m-%d").date()
    except ValueError:
        return from_date, to_date, False
    floor = end - timedelta(days=Q.MAX_RANGE_DAYS)
    if start < floor:
        return floor.isoformat(), to_date, True
    return from_date, to_date, False


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


def _today():
    """Today on the site clock (patched by the tests)."""
    return getdate(nowdate())


def _week_of(day, window, memo: dict) -> tuple:
    """``(ISO yearweek, partial, sunday)``. ``window`` is ``(from, to, today)``;
    a week is complete only when Monday ≥ from, Sunday ≤ to and Sunday < today."""
    out = memo.get(day)
    if out is None:
        start, end, today = window
        iso = day.isocalendar()
        monday = day - timedelta(days=iso[2] - 1)
        sunday = monday + timedelta(days=6)
        complete = monday >= start and sunday <= end and sunday < today
        out = memo[day] = (iso[0] * 100 + iso[1], not complete, sunday)
    return out


def _build(filters: dict, scope, job_id: str = "") -> dict:
    publish_progress(job_id, 5, "resolving filters")
    days = _days_desc(filters["from_date"], filters["to_date"])
    where, params = parent_filter_conditions(
        filters["from_date"], filters["to_date"], filters["crop"], scope,
    )
    fold = Q.Fold()
    latest: dict = {}  # house -> {"complete"|"partial": (yearweek, sunday, {station})}
    memo: dict = {}
    window = (getdate(filters["from_date"]), getdate(filters["to_date"]), _today()) if days else None
    if where != "1=0":
        sql = _ROWS.format(
            where=where,
            pest_obs=obs_filter("pest", "p.pest", params),
            disease_obs=obs_filter("disease", "d.disease", params),
        )
        for i, day in enumerate(days):
            publish_progress(job_id, 5 + (80 * i) // max(len(days), 1), f"reading {day}")
            rows = frappe.db.sql(sql, {**params, "from_date": day, "to_date": day,
                                       "sync_from": Q.SYNC_DELAY_FROM})
            if not rows:
                continue
            fold.add_day(rows)
            _note_stations(latest, rows, window, memo)

    publish_progress(job_id, 88, "station coverage")
    coverage = _coverage(latest, getdate(filters["to_date"]) if days else None)
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


def _note_stations(latest: dict, rows, window, memo: dict) -> None:
    """Days arrive newest first, so the first complete week seen for a house is
    its latest complete week (and the first unfinished one its current week);
    stations from older weeks are ignored."""
    for _s, day, wh, station, *_rest in rows:
        if not wh or not station:
            continue
        yw, partial, sunday = _week_of(day, window, memo)
        slots = latest.get(wh)
        if slots is None:
            slots = latest[wh] = {}
        slot = "partial" if partial else "complete"
        cur = slots.get(slot)
        if cur is None:
            slots[slot] = (yw, sunday, {station})
        elif cur[0] == yw:
            cur[2].add(station)


def _coverage(latest: dict, range_end) -> dict:
    """``{house: prevalence figure}`` for each house's latest complete week (or
    its partial current week when that is all the range holds) — stations,
    scouted (in its grid), coverage %, sections scouted — via ``StationWeeks``."""
    if not latest:
        return {}
    chosen = {wh: slots.get("complete") or slots["partial"] for wh, slots in latest.items()}
    ended = {wh: sunday for wh, (_yw, sunday, _st) in chosen.items()}
    partial = {wh for wh, slots in latest.items() if not slots.get("complete")}
    R.prefetch_grids(chosen)
    weeks = R.StationWeeks(
        [{"wh": wh, "station": st, "yw": yw, "in_win": 1}
         for wh, (yw, _sunday, stations) in chosen.items() for st in stations],
        [],
    )
    out = {}
    for wh in weeks.warehouses():
        week, _prev = weeks.latest_pair(wh)
        fig = weeks.figures(wh, week, "pest") if week else None
        if fig:
            out[wh] = {
                "week": week,
                "partial": wh in partial,
                "stale_days": max(0, (range_end - ended[wh]).days),
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
        "offZoneExcess": Q.OFF_ZONE_EXCESS,
        "zoneMapSuspectPct": Q.ZONE_MAP_SUSPECT_PCT,
        "duplicatePct": Q.DUPLICATE_PCT,
        "metadataMinPct": Q.METADATA_MIN_PCT,
        "staleDays": Q.STALE_DAYS,
        "maxRangeDays": Q.MAX_RANGE_DAYS,
        "syncDelayFrom": Q.SYNC_DELAY_FROM,
    }
