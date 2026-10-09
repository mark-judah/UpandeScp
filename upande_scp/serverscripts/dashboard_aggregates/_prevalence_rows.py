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
``PREVIOUS_LOOKBACK_DAYS`` before the window, so a one-week range still has a
"was" figure. A week that straddles the window start uses that whole ISO week.
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


def _load_grid(warehouse: str) -> dict:
    """{station: (row, col)} built from Zone (rose) or, failing that, Orchard Tree
    (avocado). Bed numbers come from ``Bed.bed``; zone numbers from ``Zone.zone``;
    tree numbers from the tree's name (``Orchard Tree.tree`` is 0 on every tree)."""
    rows = frappe.db.sql(
        """
        SELECT z.name, z.bed AS grp, b.bed AS grp_no, z.zone AS no
        FROM `tabZone` z
        LEFT JOIN `tabBed` b ON b.name = z.bed
        WHERE z.greenhouse = %(wh)s
        """,
        {"wh": warehouse},
        as_dict=True,
    )
    if not rows:
        rows = frappe.db.sql(
            """
            SELECT t.name, t.`row` AS grp, b.bed AS grp_no, t.tree AS no
            FROM `tabOrchard Tree` t
            LEFT JOIN `tabBed` b ON b.name = t.`row`
            WHERE t.block = %(wh)s
            """,
            {"wh": warehouse},
            as_dict=True,
        )
    return P.grid_positions(
        {
            "name": r.name,
            "group": r.grp or "",
            "group_no": P.station_number(r.grp_no, r.grp),
            "no": P.station_number(r.no, r.name),
        }
        for r in rows
    )


def station_grid(warehouse: str) -> dict:
    """Cached ``_load_grid``; dropped by ``cache_utils.invalidate_station_grid_for_doc``."""
    if not warehouse:
        return {}
    return cache_utils.get_or_set(
        grid_key(warehouse), lambda: _load_grid(warehouse), cache_utils.TTL_LONG,
    )


def _shift(day: str, days: int) -> str:
    if not day or not days:
        return day
    return (datetime.strptime(str(day)[:10], "%Y-%m-%d").date() + timedelta(days=days)).isoformat()


def _fetch_scouted(where: str, params: dict, win_from: str) -> list:
    """Distinct (house, station, ISO week) with any entry; ``in_win`` marks weeks
    that have scouting dated inside the requested window."""
    return frappe.db.sql(
        f"""
        SELECT DISTINCT {_WH} AS wh, {_STATION} AS station, {_WEEK} AS yw,
               (se.date_of_capture >= %(win_from)s) AS in_win
        FROM `tabScouting Entry` se
        WHERE {where} AND COALESCE({_STATION}, '') <> ''
        """,
        {**params, "win_from": win_from},
        as_dict=True,
    )


def _fetch_infested(where: str, params: dict, kinds) -> list:
    """Distinct (house, station, ISO week, kind, observation, stage, section).

    A pest infests when the row has a count > 0 or a recorded stage; a disease
    when the row exists (spec §1)."""
    parts = []
    if "pest" in kinds:
        parts.append(f"""
        SELECT DISTINCT {_WH} AS wh, {_STATION} AS station, {_WEEK} AS yw,
               'pest' AS kind, c.pest AS obs, COALESCE(c.stage, '') AS stage,
               COALESCE(c.plant_section, '') AS section
        FROM `tabScouting Entry` se
        JOIN `tabPests Scouting Entry` c ON c.parent = se.name
        WHERE {where}{obs_filter("pest", "c.pest", params)}
          AND COALESCE({_STATION}, '') <> ''
          AND (COALESCE(c.`count`, 0) > 0 OR COALESCE(c.stage, '') <> '')
        """)
    if "disease" in kinds:
        parts.append(f"""
        SELECT DISTINCT {_WH} AS wh, {_STATION} AS station, {_WEEK} AS yw,
               'disease' AS kind, c.disease AS obs, COALESCE(c.stage, '') AS stage,
               COALESCE(c.plant_section, '') AS section
        FROM `tabScouting Entry` se
        JOIN `tabDiseases Scouting Entry` c ON c.parent = se.name
        WHERE {where}{obs_filter("disease", "c.disease", params)}
          AND COALESCE({_STATION}, '') <> ''
        """)
    if not parts:
        return []
    return frappe.db.sql(" UNION ALL ".join(parts), params, as_dict=True)


class StationWeeks:
    """Scouted / infested station sets per (house, ISO week) and the figures over them."""

    def __init__(self, scouted_rows, infested_rows, grid_loader=None):
        self._grid_loader = grid_loader
        self._scouted: dict = {}    # (wh, week) -> {station}
        self._in_window: dict = {}  # wh -> {week with scouting inside the window}
        self._infested: dict = {}   # (wh, week) -> {(kind, obs, stage, section): {station}}
        self._grids: dict = {}
        self._counts: dict = {}
        self._pairs: dict = {}
        self._memo: dict = {}
        for r in scouted_rows or []:
            wh = (r["wh"] or "").strip()
            station = (r["station"] or "").strip()
            week = P.yearweek_label(r["yw"])
            if not wh or not station or not week:
                continue
            self._scouted.setdefault((wh, week), set()).add(station)
            if int(r["in_win"] or 0):
                self._in_window.setdefault(wh, set()).add(week)
        for r in infested_rows or []:
            wh = (r["wh"] or "").strip()
            station = (r["station"] or "").strip()
            week = P.yearweek_label(r["yw"])
            if not wh or not station or not week:
                continue
            key = (
                r["kind"],
                (r["obs"] or "").strip(),
                (r["stage"] or "").strip(),
                (r["section"] or "").strip(),
            )
            self._infested.setdefault((wh, week), {}).setdefault(key, set()).add(station)

    @classmethod
    def load(cls, from_date, to_date, crop, scope, kinds=("pest", "disease"),
             lookback_days=PREVIOUS_LOOKBACK_DAYS, grid_loader=None):
        where, params = parent_filter_conditions(
            _shift(from_date, -lookback_days), to_date, crop, scope,
        )
        return cls(
            _fetch_scouted(where, params, from_date),
            _fetch_infested(where, params, kinds),
            grid_loader=grid_loader,
        )

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
            all_weeks = [w for (h, w) in self._scouted if h == wh]
            self._pairs[wh] = P.latest_and_previous(self._in_window.get(wh, ()), all_weeks)
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
