"""Station prevalence rows — the database side of ``common/prevalence.py``.

For a crop + greenhouse scope + date window this loads, per greenhouse/block and
ISO week, the stations SCOUTED (any Scouting Entry, clean ones included) and the
stations INFESTED per (kind, observation, stage, plant section), and hands them
to the pure measure. Crop scoping is piece 1's: ``parent_filter_conditions``
(D5 — a crop-less entry counts under its greenhouse's crop) and ``obs_filter``
(D4 — off-crop pests/diseases drop out).

A station is ``Scouting Entry.zone`` (a rose ``Zone``) or, when the entry is on a
block, ``Scouting Entry.tree`` (an avocado ``Orchard Tree``). An entry with
neither (bed-only legacy rows) places no station and stays out of prevalence.

Week choice (spec D4): per house, the latest ISO week with scouting dated inside
the window, and the most recent scouted week before it — looked up to
``PREVIOUS_LOOKBACK_DAYS`` before the window (snapped back to that ISO Monday),
so a one-week range still has a "was" figure. A week that straddles the window
start uses that whole ISO week. Station sets are fetched only for the weeks
``select_weeks`` keeps, after a cheap house-week scan (see ``StationWeeks.load``).
ISO weeks come from MariaDB ``YEARWEEK(d, 3)``, the same weeks Python's
``isocalendar()`` gives (pinned at week 53 by test_prevalence_rows).
"""

from datetime import datetime, timedelta

import frappe

from upande_scp.serverscripts.common import cache_utils
from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.dashboard_aggregates._common import (
    obs_filter,
    parent_filter_conditions,
)

#: "any value" for the observation / stage / section selectors.
ANY = None
PREVIOUS_LOOKBACK_DAYS = 35

_WH = "COALESCE(NULLIF(se.block, ''), se.greenhouse)"
_STATION = "CASE WHEN COALESCE(se.block, '') <> '' THEN se.tree ELSE se.zone END"
_WEEK = "YEARWEEK(se.date_of_capture, 3)"


def grid_key(warehouse: str) -> str:
    return f"{cache_utils.K_STATION_GRID_PREFIX}:{warehouse}"


def _load_grids(warehouses) -> dict:
    """``{house: {station: (row, col)}}`` for several houses in one scan each of
    Zone (rose) and, for the houses with no zones, Orchard Tree (avocado).
    ``tabZone`` has no index on ``greenhouse``, so one batched scan replaces one
    full scan per house. Bed numbers come from ``Bed.bed``; zone numbers from
    ``Zone.zone``; tree numbers from the tree's name (``Orchard Tree.tree`` is 0
    on every tree). A house with neither keeps ``{}``."""
    houses = sorted({wh for wh in (warehouses or ()) if wh})
    if not houses:
        return {}
    rows_by: dict = {}
    for r in frappe.db.sql(
        """
        SELECT z.greenhouse AS wh, z.name, z.bed AS grp, b.bed AS grp_no, z.zone AS no
        FROM `tabZone` z
        LEFT JOIN `tabBed` b ON b.name = z.bed
        WHERE z.greenhouse IN %(whs)s
        """,
        {"whs": tuple(houses)},
        as_dict=True,
    ):
        rows_by.setdefault(r.wh, []).append(r)
    blocks = tuple(wh for wh in houses if wh not in rows_by)
    if blocks:
        for r in frappe.db.sql(
            """
            SELECT t.block AS wh, t.name, t.`row` AS grp, b.bed AS grp_no, t.tree AS no
            FROM `tabOrchard Tree` t
            LEFT JOIN `tabBed` b ON b.name = t.`row`
            WHERE t.block IN %(whs)s
            """,
            {"whs": blocks},
            as_dict=True,
        ):
            rows_by.setdefault(r.wh, []).append(r)
    return {
        wh: P.grid_positions(
            {
                "name": r.name,
                "group": r.grp or "",
                "group_no": P.station_number(r.grp_no, r.grp),
                "no": P.station_number(r.no, r.name),
            }
            for r in rows_by.get(wh, ())
        )
        for wh in houses
    }


def _load_grid(warehouse: str) -> dict:
    """One house's grid (``_load_grids`` for a single house)."""
    return _load_grids([warehouse]).get(warehouse, {})


def station_grid(warehouse: str) -> dict:
    """Cached ``_load_grid``; dropped by ``cache_utils.invalidate_station_grid_for_doc``."""
    if not warehouse:
        return {}
    return cache_utils.get_or_set(
        grid_key(warehouse), lambda: _load_grid(warehouse), cache_utils.TTL_LONG,
    )


def prefetch_grids(warehouses) -> None:
    """Warm the ``station_grid`` cache for every house in one batched load, so
    the per-house lookups that follow are cache hits."""
    cache = frappe.cache()
    missing = [wh for wh in sorted({w for w in (warehouses or ()) if w})
               if cache.get_value(grid_key(wh)) is None]
    if not missing:
        return
    for wh, grid in _load_grids(missing).items():
        cache.set_value(grid_key(wh), grid, expires_in_sec=cache_utils.TTL_LONG)


def _shift(day: str, days: int) -> str:
    if not day or not days:
        return day
    return (datetime.strptime(str(day)[:10], "%Y-%m-%d").date() + timedelta(days=days)).isoformat()


def _monday(day: str) -> str:
    """The ISO Monday on or before ``day`` (YYYY-MM-DD)."""
    if not day:
        return day
    d = datetime.strptime(str(day)[:10], "%Y-%m-%d").date()
    return (d - timedelta(days=d.weekday())).isoformat()


def lookback_start(from_date: str, lookback_days: int) -> str:
    """First day the house-week scan reads. With a lookback it snaps to the ISO
    Monday so the earliest "was" week is whole; without one it is ``from_date``
    exactly (Trends plots the window as given)."""
    if not from_date or not lookback_days:
        return from_date
    return _monday(_shift(from_date, -lookback_days))


#: Week selections for ``StationWeeks.load``.
LATEST = "latest"   # each house's latest in-window week and the scouted week before it
WINDOW = "window"   # every in-window week, plus the week before each house's latest


def select_weeks(house_weeks: dict, weeks: str = LATEST) -> set:
    """``{(house, week label)}`` whose station sets must be fetched.

    ``house_weeks`` is ``{house: {week label: in_window}}`` from the cheap
    house-week scan. ``LATEST`` keeps at most two weeks per house — the latest
    week with scouting dated inside the window and the most recent scouted week
    before it (spec D4). ``WINDOW`` keeps every in-window week too (the weekly
    series), plus that same previous week. Houses with no in-window week drop."""
    out: set = set()
    for wh, flags in house_weeks.items():
        in_win = [w for w, inside in flags.items() if inside]
        latest, previous = P.latest_and_previous(in_win, flags)
        if latest is None:
            continue
        out.add((wh, latest))
        if previous:
            out.add((wh, previous))
        if weeks == WINDOW:
            out.update((wh, w) for w in in_win)
    return out


def _fetch_house_weeks(where: str, params: dict, win_from: str) -> list:
    """(house, ISO week, any entry dated in the window) — one row per house-week,
    no station column, so the GROUP BY stays a few hundred rows."""
    return frappe.db.sql(
        f"""
        SELECT {_WH} AS wh, {_WEEK} AS yw,
               MAX(se.date_of_capture >= %(win_from)s) AS in_win
        FROM `tabScouting Entry` se
        WHERE {where} AND COALESCE({_STATION}, '') <> ''
        GROUP BY wh, yw
        """,
        {**params, "win_from": win_from},
    )


def _pairs_clause(pairs) -> str:
    """Restrict a station scan to the selected (house, ISO week) pairs; ``""``
    when every house-week in the scanned range is wanted anyway."""
    return "" if pairs is None else f" AND ({_WH}, {_WEEK}) IN %(sw_pairs)s"


def _fetch_scouted(where: str, params: dict, pairs=None) -> list:
    """(house, station, ISO week) per entry with a station. Not DISTINCT on
    purpose: MariaDB's temp-table dedup of ~10⁵ rows cost seconds, a Python set
    costs a fraction of that."""
    return frappe.db.sql(
        f"""
        SELECT {_WH}, {_STATION}, {_WEEK}
        FROM `tabScouting Entry` se
        WHERE {where} AND COALESCE({_STATION}, '') <> ''{_pairs_clause(pairs)}
        """,
        params,
    )


def _fetch_infested(where: str, params: dict, kinds, pairs=None) -> list:
    """(house, station, ISO week, kind, observation, stage, section) per child row.

    A pest infests when the row has a count > 0 or a recorded stage; a disease
    when the row exists (spec §1). Not DISTINCT — deduplicated into sets."""
    restrict = _pairs_clause(pairs)
    parts = []
    if "pest" in kinds:
        parts.append(f"""
        SELECT {_WH}, {_STATION}, {_WEEK}, 'pest', c.pest,
               COALESCE(c.stage, ''), COALESCE(c.plant_section, '')
        FROM `tabScouting Entry` se
        JOIN `tabPests Scouting Entry` c ON c.parent = se.name
        WHERE {where}{obs_filter("pest", "c.pest", params)}
          AND COALESCE({_STATION}, '') <> ''{restrict}
          AND (COALESCE(c.`count`, 0) > 0 OR COALESCE(c.stage, '') <> '')
        """)
    if "disease" in kinds:
        parts.append(f"""
        SELECT {_WH}, {_STATION}, {_WEEK}, 'disease', c.disease,
               COALESCE(c.stage, ''), COALESCE(c.plant_section, '')
        FROM `tabScouting Entry` se
        JOIN `tabDiseases Scouting Entry` c ON c.parent = se.name
        WHERE {where}{obs_filter("disease", "c.disease", params)}
          AND COALESCE({_STATION}, '') <> ''{restrict}
        """)
    if not parts:
        return []
    return frappe.db.sql(" UNION ALL ".join(parts), params)


class StationWeeks:
    """Scouted / infested station sets per (house, ISO week) and the figures over them."""

    def __init__(self, scouted_rows, infested_rows, grid_loader=None):
        """``scouted_rows`` / ``infested_rows`` are dicts (``wh``, ``station``,
        ``yw``, ``in_win`` / ``kind``, ``obs``, ``stage``, ``section``) — the
        hand-built shape the pure tests use. ``load`` fills the sets directly."""
        self._grid_loader = grid_loader
        self._scouted: dict = {}    # (wh, week) -> {station}
        self._in_window: dict = {}  # wh -> {week with scouting inside the window}
        self._all_weeks: dict = {}  # wh -> {every scouted week scanned}
        self._infested: dict = {}   # (wh, week) -> {(kind, obs, stage, section): {station}}
        self._grids: dict = {}
        self._counts: dict = {}
        self._pairs: dict = {}
        self._memo: dict = {}
        self._labels: dict = {}
        for r in scouted_rows or []:
            if self._add_scouted(r["wh"], r["station"], r["yw"]) and int(r["in_win"] or 0):
                self._in_window.setdefault((r["wh"] or "").strip(), set()).add(self._label(r["yw"]))
        for r in infested_rows or []:
            self._add_infested(r["wh"], r["station"], r["yw"], r["kind"], r["obs"], r["stage"], r["section"])

    def _label(self, yw) -> str:
        label = self._labels.get(yw)
        if label is None:
            label = self._labels[yw] = P.yearweek_label(yw)
        return label

    def _add_scouted(self, wh, station, yw) -> bool:
        wh = (wh or "").strip()
        station = (station or "").strip()
        week = self._label(yw)
        if not wh or not station or not week:
            return False
        self._scouted.setdefault((wh, week), set()).add(station)
        self._all_weeks.setdefault(wh, set()).add(week)
        return True

    def _add_infested(self, wh, station, yw, kind, obs, stage, section):
        wh = (wh or "").strip()
        station = (station or "").strip()
        week = self._label(yw)
        if not wh or not station or not week:
            return
        key = (kind, (obs or "").strip(), (stage or "").strip(), (section or "").strip())
        self._infested.setdefault((wh, week), {}).setdefault(key, set()).add(station)

    @classmethod
    def load(cls, from_date, to_date, crop, scope, kinds=("pest", "disease"),
             lookback_days=PREVIOUS_LOOKBACK_DAYS, grid_loader=None, weeks=LATEST):
        """Three scans, all through piece 1's crop scoping:

        1. house-weeks (no station column) over the lookback + window → which
           weeks each house was scouted, and which of those fall in the window;
        2. ``select_weeks`` keeps each house's latest + previous week (``LATEST``:
           Overview, GH detail) or every in-window week as well (``WINDOW``:
           Pests/Diseases' weekly line, Trends);
        3. scouted and infested stations for only those (house, week) pairs,
           read from the earliest selected Monday on.

        In ``LATEST`` mode only ``latest`` / ``previous`` / ``latest_by_house`` /
        ``combined_latest`` are meaningful; the per-week helpers need ``WINDOW``."""
        start = lookback_start(from_date, lookback_days)
        where, params = parent_filter_conditions(start, to_date, crop, scope)
        out = cls([], [], grid_loader=grid_loader)
        house_weeks: dict = {}
        for wh, yw, in_win in _fetch_house_weeks(where, params, from_date):
            wh = (wh or "").strip()
            week = out._label(yw)
            if wh and week:
                inside = bool(int(in_win or 0))
                flags = house_weeks.setdefault(wh, {})
                flags[week] = flags.get(week, False) or inside
        for wh, flags in house_weeks.items():
            out._all_weeks[wh] = set(flags)
            inside = {w for w, f in flags.items() if f}
            if inside:
                out._in_window[wh] = inside
        selected = select_weeks(house_weeks, weeks)
        if not selected:
            return out
        if grid_loader is None:
            prefetch_grids({wh for wh, _w in selected})
        first = min(P.week_monday(w) for _wh, w in selected)
        scan_from = max(first, start) if start else first
        wanted_in_range = sum(
            1 for flags in house_weeks.values() for w in flags if P.week_monday(w) >= first
        )
        pairs = None
        if len(selected) < wanted_in_range:
            pairs = tuple(sorted((wh, int(w.replace("-W", ""))) for wh, w in selected))
        where, params = parent_filter_conditions(scan_from, to_date, crop, scope)
        if pairs is not None:
            params["sw_pairs"] = pairs
        for wh, station, yw in _fetch_scouted(where, params, pairs):
            out._add_scouted(wh, station, yw)
        for wh, station, yw, kind, obs, stage, section in _fetch_infested(where, params, kinds, pairs):
            out._add_infested(wh, station, yw, kind, obs, stage, section)
        return out

    # ── structure ──────────────────────────────────────────────────────────

    def grid(self, wh: str) -> dict:
        if wh not in self._grids:
            loader = self._grid_loader or station_grid  # looked up now, so tests can patch it
            self._grids[wh] = loader(wh) or {}
        return self._grids[wh]

    def warehouses(self) -> list:
        """Houses with scouting inside the window, sorted."""
        return sorted(self._in_window)

    def window_weeks(self) -> list:
        return sorted({w for weeks in self._in_window.values() for w in weeks})

    def warehouses_in(self, week: str) -> list:
        return sorted(wh for wh, weeks in self._in_window.items() if week in weeks)

    def weeks(self, wh: str) -> list:
        return sorted(self._in_window.get(wh, ()))

    def latest_pair(self, wh: str) -> tuple:
        if wh not in self._pairs:
            self._pairs[wh] = P.latest_and_previous(
                self._in_window.get(wh, ()), self._all_weeks.get(wh, ()),
            )
        return self._pairs[wh]

    # ── figures ────────────────────────────────────────────────────────────

    def infested_set(self, wh, week, kind, obs=ANY, stage=ANY, section=ANY) -> set:
        out: set = set()
        for (k, o, g, s), stations in self._infested.get((wh, week), {}).items():
            if k != kind:
                continue
            if obs is not ANY and o != obs:
                continue
            if stage is not ANY and g != stage:
                continue
            if section is not ANY and s != section:
                continue
            out |= stations
        return out

    def figures(self, wh, week, kind, obs=ANY, stage=ANY, section=ANY):
        key = (wh, week, kind, obs, stage, section)
        if key not in self._memo:
            scouted = self._scouted.get((wh, week))
            fig = None
            if scouted:
                grid = self.grid(wh)
                if (wh, week) not in self._counts:
                    self._counts[(wh, week)] = P.section_counts(grid, scouted)
                fig = P.figures(
                    grid, scouted,
                    self.infested_set(wh, week, kind, obs, stage, section),
                    scouted_counts=self._counts[(wh, week)],
                )
                if fig is not None:
                    fig["week"] = week
            self._memo[key] = fig
        return self._memo[key]

    def latest(self, wh, kind, obs=ANY, stage=ANY, section=ANY):
        latest, previous = self.latest_pair(wh)
        if latest is None:
            return None
        fig = self.figures(wh, latest, kind, obs, stage, section)
        if fig is None:
            return None
        prev = self.figures(wh, previous, kind, obs, stage, section) if previous else None
        return {**fig, "prev": prev["prevalence"] if prev else None}

    def previous(self, wh, kind, obs=ANY, stage=ANY, section=ANY):
        _latest, previous = self.latest_pair(wh)
        return self.figures(wh, previous, kind, obs, stage, section) if previous else None

    def combined(self, week, kind, obs=ANY, stage=ANY, section=ANY):
        """Scope-wide figures for one ISO week: every house scouted that week,
        station-weighted (``prevalence.combine``). ``None`` when no house has a
        figure that week."""
        return P.combine([
            self.figures(wh, week, kind, obs, stage, section)
            for wh in self.warehouses_in(week)
        ])

    def latest_by_house(self, kind, stage=ANY, section=ANY):
        """``{house: {observation: latest(...)}}`` for every house scouted in the
        window — the latest-week figure (with ``week`` and ``prev``) of each
        observation seen in that house's latest or previous week. A house with
        no stations still appears, its figures carrying ``prevalence`` None."""
        out: dict = {}
        for wh in self.warehouses():
            latest, previous = self.latest_pair(wh)
            seen: set = set()
            for week in (latest, previous):
                for (k, o, _g, _s) in self._infested.get((wh, week), {}):
                    if k == kind and o:
                        seen.add(o)
            per = {}
            for o in sorted(seen):
                fig = self.latest(wh, kind, o, stage, section)
                if fig is not None:
                    per[o] = fig
            out[wh] = per
        return out

    def combined_latest(self, kind, obs=ANY, stage=ANY, section=ANY):
        """Scope-wide figures: every house's latest week, station-weighted."""
        houses = self.warehouses()
        out = P.combine([self.latest(wh, kind, obs, stage, section) for wh in houses])
        if out is None:
            return None
        prev = P.combine([self.previous(wh, kind, obs, stage, section) for wh in houses])
        return {**out, "prev": prev["prevalence"] if prev else None}
