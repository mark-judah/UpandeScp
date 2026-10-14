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

Each capture date's fold is cached as a per-date partial (``day_partials``,
spec 2026-10-11-quality-weekly-partials-design), so a range is assembled from
Redis and only dates never read — or dropped by a scouting write — touch the DB.
Measured on kaitet.local, Rose 4 weeks all farms: 11.5 s cold, 0.36 s from warm
partials; ``prewarm.prewarm_quality`` keeps the last 8 weeks warm.
"""

import pickle
import zlib
from datetime import datetime, timedelta

import frappe
from frappe.utils import getdate, nowdate

from upande_scp.serverscripts.common import cache_utils
from upande_scp.serverscripts.common import quality_rules as Q
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    coerce_date,
    filter_hash,
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


def quality(args: dict, force: bool = False, farms_map: dict | None = None) -> dict:
    """``farms_map`` — the caller's ``get_farms_and_warehouses()``, when it has
    already read it (one indexed probe per disabled house; ~0.3 s on kaitet)."""
    if farms_map is None:
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
        "quality", filters, lambda: _build(filters, scope, job_id, force=force), force=force,
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


def _build(filters: dict, scope, job_id: str = "", force: bool = False) -> dict:
    publish_progress(job_id, 5, "resolving filters")
    days = _days_desc(filters["from_date"], filters["to_date"])
    where, params = parent_filter_conditions(
        filters["from_date"], filters["to_date"], filters["crop"], scope,
    )
    fold = Q.Fold()
    latest: dict = {}  # house -> {"complete"|"partial": (yearweek, sunday, {station})}
    memo: dict = {}
    window = (getdate(filters["from_date"]), getdate(filters["to_date"]), _today()) if days else None
    if where != "1=0" and days:
        # Newest first, as the scan read them: the merge order is what keeps the
        # figures identical to one fold over the whole range (Fold.merge).
        partials = day_partials(where, params, days, job_id=job_id, force=force)
        for day in days:
            day_fold, stations = partials[day]
            fold.merge(day_fold)
            _note_stations(latest, getdate(day), stations, window, memo)

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


# ── per-day partials (spec 2026-10-11-quality-weekly-partials-design) ─────────
#
# Every figure the fold makes is per row or per scout-day, so one capture date's
# Fold is a self-contained, mergeable building block. Each (query scope, date)
# Fold is cached in Redis; a range is the merge of its days' Folds, newest first.
# A scouting write drops only its date (a per-date generation stamp), so the
# warm history survives the day being scouted.

K_QP_PREFIX = "scp:dash_agg:qpart"
#: Bump when the partial's contents change meaning (the row SQL or the Fold).
K_QP_SCHEMA = "qp1"
#: Dates within this many days of today change under late syncs and edits; their
#: partials live shorter. Writes drop a partial at once either way — the TTL only
#: bounds out-of-band writes (raw SQL loads) that fire no doc event.
QP_RECENT_DAYS = 7
QP_TTL_RECENT = 3600
QP_TTL_OLD = 86400


def _scope_sig(where: str, params: dict) -> str:
    """The query a day's partial was read with, minus its dates: the crop, its
    pests/diseases and houses (D4, D5), the greenhouse scope. A change to any of
    them — a house moved between farms, a pest linked to the crop — is a new
    signature, so no partial is ever served for a query it was not read with."""
    rest = {k: v for k, v in params.items() if k not in ("from_date", "to_date")}
    return filter_hash({"where": where, "params": rest, "sync": Q.SYNC_DELAY_FROM})


def _partial_key(sig: str, day: str, gen: str) -> str:
    return f"{K_QP_PREFIX}:{K_QP_SCHEMA}:{sig}:{day}:{gen}"


def _gens(cache, days: list) -> dict:
    """``{day: generation}`` — created (unique) where missing, so a flushed or
    evicted stamp can never re-match a partial built under an older one."""
    keys = [cache.make_key(cache_utils.quality_day_gen_key(d)) for d in days]
    raw = cache.mget(keys) if keys else []
    out = {}
    for day, key, val in zip(days, keys, raw):
        if val is None:
            cache.set(key, cache_utils.new_quality_gen(), nx=True)
            val = cache.get(key)
        out[day] = val.decode() if isinstance(val, bytes) else str(val)
    return out


def _load(blob):
    try:
        return pickle.loads(zlib.decompress(blob))
    except Exception:
        return None


def day_partials(where: str, params: dict, days: list, job_id: str = "",
                 force: bool = False, fill_only: bool = False) -> dict:
    """``{day: (Fold, {house: [station, …]})}`` for each date in ``days`` — from
    Redis where cached, else read from the DB (one query per date, as the scan
    always did) and cached. ``force`` re-reads every date; ``fill_only`` (the
    warmer) only builds the missing dates and returns just those."""
    cache = frappe.cache()
    sig = _scope_sig(where, params)
    gens = _gens(cache, days)
    keys = {d: cache.make_key(_partial_key(sig, d, gens[d])) for d in days}
    out: dict = {}
    if fill_only and not force:
        pipe = cache.pipeline()
        for d in days:
            pipe.exists(keys[d])
        present = {d for d, hit in zip(days, pipe.execute()) if hit}
        missing = [d for d in days if d not in present]
    else:
        if not force:
            for day, blob in zip(days, cache.mget([keys[d] for d in days])):
                if blob is not None:
                    got = _load(blob)
                    if got is not None:
                        out[day] = got
        missing = [d for d in days if d not in out]
    if not missing:
        return out
    sql = _ROWS.format(
        where=where,
        pest_obs=obs_filter("pest", "p.pest", params),
        disease_obs=obs_filter("disease", "d.disease", params),
    )
    recent = (_today() - timedelta(days=QP_RECENT_DAYS)).isoformat()
    for i, day in enumerate(missing):
        publish_progress(job_id, 5 + (80 * i) // len(missing), f"reading {day}")
        rows = frappe.db.sql(sql, {**params, "from_date": day, "to_date": day,
                                   "sync_from": Q.SYNC_DELAY_FROM})
        out[day] = part = _day_partial(rows)
        cache.set(keys[day], zlib.compress(pickle.dumps(part, pickle.HIGHEST_PROTOCOL), 1),
                  ex=QP_TTL_RECENT if day >= recent else QP_TTL_OLD)
    return out


def _day_partial(rows) -> tuple:
    """One capture date's ``(Fold, {house: [station, …]})``; the stations keep
    their first-seen order."""
    fold = Q.Fold()
    stations: dict = {}
    if rows:
        fold.add_day(rows)
        for _s, _day, wh, station, *_rest in rows:
            if not wh or not station:
                continue
            seen = stations.get(wh)
            if seen is None:
                seen = stations[wh] = {}
            seen[station] = None
    return fold, {wh: list(st) for wh, st in stations.items()}


def _note_stations(latest: dict, day, stations: dict, window, memo: dict) -> None:
    """Days arrive newest first, so the first complete week seen for a house is
    its latest complete week (and the first unfinished one its current week);
    stations from older weeks are ignored."""
    if not stations:
        return
    yw, partial, sunday = _week_of(day, window, memo)
    slot = "partial" if partial else "complete"
    for wh, sts in stations.items():
        slots = latest.get(wh)
        if slots is None:
            slots = latest[wh] = {}
        cur = slots.get(slot)
        if cur is None:
            slots[slot] = (yw, sunday, set(sts))
        elif cur[0] == yw:
            cur[2].update(sts)


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
