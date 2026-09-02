"""Trends page aggregator.

Replaces the per-week ``getScoutingEntriesChunk`` round-trip pattern that
made the Scouting Trends page slow. One cached call returns:

  * ``options``   — the picker trees (farms→stations, pests, diseases,
                    stagesByObs)
  * three flat **lookup tables** keyed by integer indices into ``vocab``:
      - ``byKindNameStage`` rows = ``[week, station, obs, stage, n]``
      - ``byKindName``      rows = ``[week, station, obs, n]``
      - ``byAny``           rows = ``[week, station, n]``
    where ``n`` is the count of distinct **unit keys** that match. Unit
    keys are station-prefixed (e.g. ``zone::Z1``, ``block::tree::T7``)
    so summing ``n`` across stations remains correct.
  * ``scoutedByStation`` rows = ``[week, station, n]`` — distinct units with
    ANY Scouting Entry in the bucket. This is the **incidence denominator**
    (the sample size), and it is the one number the observation tables above
    cannot supply: they INNER JOIN the pest/disease children, so a unit that
    was scouted and found clean produces no row at all. See ``_fetch_scouted``.
  * ``intensityByStation`` rows = ``[week, station, obs, sum_c]`` — pest-only
    intensity, ``sum_c`` = Σ over affected units of that unit's mean per-visit
    count. Pairs with the incidence numerator to give pressure/severity.
  * ``vocab`` — string arrays the indices resolve into
  * ``stationsByFarm`` / ``unitsByStation`` / ``allWeeks`` /
    ``unitTotalsByStation`` — structural metadata for the X-axis, farm rollup
    and the coverage readout

Percentages
-----------
Incidence is ``100 × affected_units / scouted_units`` per (ISO week,
selection). It used to divide by ``unitTotalsByStation`` — every unit that
*exists* — which silently plotted ``incidence × coverage``: it understated by
2–2.5× and, worse, moved with scouting effort, so a week with fewer scouts
looked like an improvement. ``unitTotalsByStation`` is still published, but now
only as the denominator of **coverage**, the question it was actually correct
for. See docs/superpowers/specs/2026-08-10-trends-incidence-denominator-design.md

Buckets are ISO weeks via ``YEARWEEK(date, 3)`` — matching the real scouting
cycle, so each bucket holds a near-complete sample. ``Scouting Entry.week_number``
is NOT used: it is 0 on every row on this site.

Cache key hashes (from_date, to_date, crop). 60s TTL. Realtime push will
expire the key promptly via the standard ``scp:scouting:dirty`` channel
once subscribers register; until then the TTL bounds staleness.
"""

from datetime import date, datetime

import frappe

from upande_scp.serverscripts.scouting import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    parent_filter_conditions,
    publish_progress,
)

# Bumped from "trends" when the payload moved to ISO-week buckets and gained
# scoutedByStation. A cached v1 payload has no scouted counts and daily keys, so
# the new client must not be allowed to read one.
_ENDPOINT = "trends_v2"


def trends(args: dict, force: bool = False) -> dict:
    from_date = args.get("from_date", "")
    to_date   = args.get("to_date", "")
    crop      = (args.get("crop") or "").strip()
    job_id    = (args.get("job_id") or "").strip()

    cache_filters = {"from_date": from_date, "to_date": to_date, "crop": crop}
    return cached_aggregate(
        _ENDPOINT,
        cache_filters,
        lambda: _build(from_date, to_date, crop, job_id),
        force=force,
    )


def _build(from_date: str, to_date: str, crop: str, job_id: str = "") -> dict:
    publish_progress(job_id, 5, "resolving filters")
    where, params = parent_filter_conditions(from_date, to_date, crop, None)

    publish_progress(job_id, 25, "loading entries")
    rows = _fetch_observations(where, params)

    publish_progress(job_id, 50, "loading scouted units")
    scouted_rows = _fetch_scouted(where, params)

    publish_progress(job_id, 70, "aggregating")
    payload = _aggregate(rows, scouted_rows)

    publish_progress(job_id, 95, "loading unit counts")
    # Structural unit count per station, inferred from the warehouse type:
    # Greenhouse → Zones, Block → Orchard Trees (and a future type → Triads
    # for coffee). This is the total scouting units that *exist*.
    #
    # It is the denominator of COVERAGE only. It used to be the denominator of
    # the charted percentage, which made that percentage `incidence × coverage`
    # — see the module docstring. Incidence now divides by scoutedByStation.
    units = scouting_metrics.get_units_by_warehouse() or {}
    payload["unitTotalsByStation"] = {
        k: int((v or {}).get("count") or 0) for k, v in units.items()
    }

    # Dynamic unit label for the chart, from the warehouse types of the
    # stations actually present in this (crop-scoped) payload.
    type_label = {"greenhouse": "zone", "block": "tree", "triad": "triad"}
    type_tally: dict[str, int] = {}
    for s in payload.get("vocab", {}).get("stations", []):
        t = (units.get(s) or {}).get("type")
        if t:
            type_tally[t] = type_tally.get(t, 0) + 1
    dominant = max(type_tally, key=type_tally.get) if type_tally else "greenhouse"
    label = type_label.get(dominant, dominant)
    payload["unitLabel"] = label
    payload["unitLabelPlural"] = label + "s"

    # Control actions (spray plans) for the stations in this payload, so the
    # chart can mark the weeks where something was done about a pest.
    payload["sprayEvents"] = _fetch_spray_events(
        from_date, to_date, payload.get("vocab", {}).get("stations", []) or []
    )

    publish_progress(job_id, 100, "")
    return payload


def week_key(value) -> str:
    """ISO-week bucket label, e.g. ``2026-W28``.

    ISO weeks (Monday-start) match the scouting cycle, so a bucket holds a
    near-complete sample of each station's units. Zero-padded so plain string
    sort is chronological. Returns "" for an unparseable date.

    Deliberately NOT ``Scouting Entry.week_number`` — that column is 0 on every
    row on this site — and computed in Python rather than SQL so the observation
    and scouted queries cannot drift apart.
    """
    if isinstance(value, datetime):
        value = value.date()
    if not isinstance(value, date):
        try:
            value = datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
        except (TypeError, ValueError):
            return ""
    iso = value.isocalendar()
    return f"{iso[0]:04d}-W{iso[1]:02d}"


def _fetch_observations(where: str, params: dict) -> list:
    """One row per (entry, observation kind, child row).

    Trends only graphs pests + diseases; traps live on a different
    dashboard tab so they're skipped here.

    ``obs_count`` carries the pest intensity (``Pests Scouting Entry.count``,
    populated on every row). Diseases have no count column, so they report 0 and
    are excluded from the intensity table downstream.
    """
    return frappe.db.sql(
        f"""
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               se.bed, se.zone, se.tree,
               'pest' AS kind,
               p.pest AS obs_name, p.stage AS stage,
               p.`count` AS obs_count
        FROM `tabScouting Entry` se
        JOIN `tabPests Scouting Entry` p ON p.parent = se.name
        WHERE {where}
        UNION ALL
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               se.bed, se.zone, se.tree,
               'disease' AS kind,
               d.disease AS obs_name, d.stage AS stage,
               0 AS obs_count
        FROM `tabScouting Entry` se
        JOIN `tabDiseases Scouting Entry` d ON d.parent = se.name
        WHERE {where}
        """,
        params,
        as_dict=True,
    )


def _fetch_spray_events(from_date: str, to_date: str, stations: list) -> dict:
    """Control actions per (ISO week, greenhouse) — the spray overlay.

    Keyed ``"<week>|<station>"`` → list of events, each carrying the chemicals
    applied, their active ingredients, the declared targets and the spray type.
    Lets the chart mark the weeks where something was actually DONE about a
    pest, next to the line showing whether it worked.

    Source is ``Work Order Item``, NOT the BOM. All 3,366 greenhouse Work Orders
    reference a BOM, but only 3 of the 2,230 distinct BOMs have any
    ``BOM Explosion Item`` rows — joining through the BOM (as ``get_bom_details``
    does) yields 1 distinct chemical across the whole dataset, versus 54 here.

    ``custom_targets`` is a newline-separated list whose entries match the
    pest/disease names on the chart, so the client can tell an on-target spray
    from an unrelated one.
    """
    if not stations:
        return {}

    rows = frappe.db.sql(
        """
        SELECT wo.name              AS wo,
               wo.custom_greenhouse AS station,
               wo.planned_start_date AS planned,
               wo.custom_spray_type AS spray_type,
               wo.custom_targets    AS targets,
               i.item_name          AS chemical,
               ai.ingredient        AS ingredient
        FROM   `tabWork Order`      wo
        JOIN   `tabWork Order Item` woi ON woi.parent = wo.name
        JOIN   `tabItem`            i   ON i.name = woi.item_code
        LEFT JOIN `tabSpray Product` c  ON c.item = woi.item_code
        LEFT JOIN `tabActive Ingredient` ai
               ON ai.parent = c.name AND ai.parenttype = 'Spray Product'
        WHERE  wo.docstatus < 2
          AND  wo.custom_greenhouse IN %(stations)s
          AND  DATE(wo.planned_start_date) BETWEEN %(from_date)s AND %(to_date)s
        """,
        {
            "stations": tuple(stations),
            "from_date": from_date,
            "to_date": to_date,
        },
        as_dict=True,
    )

    # Fold the row-per-(item, ingredient) fan-out back into one entry per WO.
    by_wo: dict[str, dict] = {}
    for r in rows:
        week = week_key(r.planned)
        if not week:
            continue
        e = by_wo.setdefault(
            r.wo,
            {
                "week": week,
                "station": r.station,
                "date": str(r.planned)[:10],
                "sprayType": (r.spray_type or "").strip(),
                "chemicals": set(),
                "ingredients": set(),
                "targets": set(),
            },
        )
        if r.chemical:
            e["chemicals"].add(r.chemical)
        if r.ingredient:
            e["ingredients"].add(r.ingredient)
        for t in (r.targets or "").replace("\r", "").split("\n"):
            t = t.strip()
            if t:
                e["targets"].add(t)

    out: dict[str, list] = {}
    for e in by_wo.values():
        out.setdefault(f"{e['week']}|{e['station']}", []).append(
            {
                "date": e["date"],
                "sprayType": e["sprayType"],
                "chemicals": sorted(e["chemicals"]),
                "ingredients": sorted(e["ingredients"]),
                "targets": sorted(e["targets"]),
            }
        )
    for events in out.values():
        events.sort(key=lambda x: x["date"])
    return out


def _fetch_scouted(where: str, params: dict) -> list:
    """One row per Scouting Entry — **no join to the observation children**.

    This is the whole point of the incidence fix. ``_fetch_observations`` INNER
    JOINs the pest/disease child tables, so a unit that was scouted and found
    clean contributes no row and is invisible to it. On this site only 102,335 of
    297,131 entries have pests and 37,412 have diseases, so the large majority of
    scouting effort is clean — and that effort IS the sample size.

    Same columns as ``_fetch_observations`` so the identical ``_unit_key`` /
    ``_station_of`` / ``week_key`` helpers apply to both. That shared derivation
    is what guarantees ``affected ⊆ scouted``, and therefore incidence ≤ 100%.
    """
    return frappe.db.sql(
        f"""
        SELECT se.date_of_capture, se.greenhouse, se.block,
               se.bed, se.zone, se.tree
        FROM `tabScouting Entry` se
        WHERE {where}
        """,
        params,
        as_dict=True,
    )


def _station_of(row) -> str:
    return ((row.block or "") or (row.greenhouse or "")).strip()


def _unit_key(row) -> str:
    """Same logic as aggregate.ts/unitKey — block.tree path for avocado,
    zone for greenhouse, bed as final fallback. Empty string drops the row
    from the index (no usable unit identifier)."""
    block = (row.block or "").strip()
    if block:
        tree = (row.tree or "").strip()
        if not tree:
            return ""
        return f"{block}::tree::{tree}"
    zone = (row.zone or "").strip()
    if zone:
        return f"zone::{zone}"
    bed = (row.bed or "").strip()
    return f"bed::{bed}" if bed else ""


def _aggregate(rows: list, scouted_rows: list | None = None) -> dict:
    """Single pass over the observation rows produces:

      * options bundle (farmStations, pests, diseases, stagesByObs)
      * three lookup tables of distinct-unit counts (the incidence numerators)
      * the pest intensity table
      * the structural metadata (stationsByFarm, unitsByStation, allWeeks)

    A second pass over ``scouted_rows`` produces ``scoutedByStation`` — the
    incidence DENOMINATOR (distinct units with any entry in the bucket).

    ``rows`` comes from a UNION ALL query with no ORDER BY, so its scan
    order is not defined. The grouping pass below keys everything by the
    actual week/station/obs/stage *strings* (not vocab indices), which
    makes the grouping itself immune to row order. Vocab indices are then
    assigned afterwards from sorted vocabularies, so which integer a given
    week/station/obs/stage gets — and the row order of byAny/byKindName/
    byKindNameStage — no longer depends on the database's scan order.
    """
    farms_map = scouting_metrics.get_farms_and_warehouses() or {}
    station_to_farm: dict[str, str] = {}
    for farm, stations in farms_map.items():
        for s in stations or []:
            station_to_farm[s] = farm

    # Option trees
    farm_stations: dict[str, dict[str, int]] = {}
    pests: dict[str, int] = {}
    diseases: dict[str, int] = {}
    stages_by_obs: dict[str, set] = {}

    # Distinct-unit sets keyed by the actual string dimensions (not vocab
    # indices) so the grouping never depends on row scan order.
    units_kns: dict[tuple, set] = {}  # (week, station, obs_key, stage) → {unit}
    units_kn:  dict[tuple, set] = {}  # (week, station, obs_key)       → {unit}
    units_any: dict[tuple, set] = {}  # (week, station)                → {unit}

    # Incidence denominator: (week, station) → {unit scouted, clean or not}.
    units_scouted: dict[tuple, set] = {}

    # Pest intensity, two-level so repeat visits of one unit don't multiply it:
    #   (week, station, obs_key, unit) → {entry: Σ count on that entry}
    # collapsed later to a per-unit MEAN, then summed across units.
    counts_per_entry: dict[tuple, dict] = {}

    # Structural metadata
    stations_by_farm: dict[str, set] = {}
    units_by_station: dict[str, set] = {}

    for r in rows:
        station = _station_of(r)
        if not station:
            continue
        unit = _unit_key(r)
        if not unit:
            continue
        obs_name = (r.obs_name or "").strip()
        if not obs_name:
            continue

        week = week_key(r.date_of_capture)
        if not week:
            continue
        farm = station_to_farm.get(station, "Unknown")
        stage = (r.stage or "").strip()

        # Picker counts ─ total observations (NOT distinct units) per
        # station/obs to match the legacy ``gatherOptions`` semantics.
        farm_stations.setdefault(farm, {})
        farm_stations[farm][station] = farm_stations[farm].get(station, 0) + 1
        if r.kind == "pest":
            pests[obs_name] = pests.get(obs_name, 0) + 1
            obs_key = f"pest:{obs_name}"
        else:
            diseases[obs_name] = diseases.get(obs_name, 0) + 1
            obs_key = f"disease:{obs_name}"
        if stage:
            stages_by_obs.setdefault(obs_key, set()).add(stage)

        units_any.setdefault((week, station), set()).add(unit)
        units_kn.setdefault((week, station, obs_key), set()).add(unit)
        units_kns.setdefault((week, station, obs_key, stage), set()).add(unit)

        # Pests only — diseases carry no count column and report 0.
        if r.kind == "pest":
            per_entry = counts_per_entry.setdefault((week, station, obs_key, unit), {})
            entry = r.name
            per_entry[entry] = per_entry.get(entry, 0.0) + float(r.obs_count or 0)

        stations_by_farm.setdefault(farm, set()).add(station)
        units_by_station.setdefault(station, set()).add(unit)

    # Denominator pass. Uses the SAME station/unit/week derivation as above, so
    # every unit that appears in units_* is guaranteed to appear here too —
    # affected ⊆ scouted, hence incidence ≤ 100%.
    for r in (scouted_rows or []):
        station = _station_of(r)
        if not station:
            continue
        unit = _unit_key(r)
        if not unit:
            continue
        week = week_key(r.date_of_capture)
        if not week:
            continue
        units_scouted.setdefault((week, station), set()).add(unit)

    # Per-unit intensity: collapse repeat visits to a MEAN so a unit scouted
    # three times in a week doesn't contribute three times, then sum across the
    # affected units of each (week, station, obs).
    intensity_sums: dict[tuple, float] = {}
    for (week, station, obs_key, _unit), per_entry in counts_per_entry.items():
        if not per_entry:
            continue
        unit_mean = sum(per_entry.values()) / len(per_entry)
        key = (week, station, obs_key)
        intensity_sums[key] = intensity_sums.get(key, 0.0) + unit_mean

    # Vocabularies, sorted so index assignment doesn't depend on row scan order.
    # Index 0 in vocab_stages stays reserved for "no stage", as before.
    #
    # Weeks and stations union the observation and scouted passes: a station with
    # scouting but zero observations has a real denominator (and 0% incidence),
    # which is exactly the signal the old model threw away.
    vocab_weeks:    list[str] = sorted(
        {w for (w, _s) in units_any} | {w for (w, _s) in units_scouted}
    )
    vocab_stations: list[str] = sorted(
        {s for (_w, s) in units_any} | {s for (_w, s) in units_scouted}
    )
    vocab_obs:      list[str] = sorted({o for (_w, _s, o) in units_kn})
    vocab_stages:   list[str] = [""] + sorted({g for *_, g in units_kns if g})

    idx_weeks    = {w: i for i, w in enumerate(vocab_weeks)}
    idx_stations = {s: i for i, s in enumerate(vocab_stations)}
    idx_obs      = {o: i for i, o in enumerate(vocab_obs)}
    idx_stages   = {g: i for i, g in enumerate(vocab_stages)}

    by_any: list[list[int]] = sorted(
        ([idx_weeks[w], idx_stations[s], len(u)] for (w, s), u in units_any.items()),
        key=lambda row: (row[0], row[1]),
    )
    by_kn: list[list[int]] = sorted(
        (
            [idx_weeks[w], idx_stations[s], idx_obs[o], len(u)]
            for (w, s, o), u in units_kn.items()
        ),
        key=lambda row: (row[0], row[1], row[2]),
    )
    by_kns: list[list[int]] = sorted(
        (
            [idx_weeks[w], idx_stations[s], idx_obs[o], idx_stages[g], len(u)]
            for (w, s, o, g), u in units_kns.items()
        ),
        key=lambda row: (row[0], row[1], row[2], row[3]),
    )
    scouted: list[list[int]] = sorted(
        (
            [idx_weeks[w], idx_stations[s], len(u)]
            for (w, s), u in units_scouted.items()
        ),
        key=lambda row: (row[0], row[1]),
    )
    intensity: list[list] = sorted(
        (
            [idx_weeks[w], idx_stations[s], idx_obs[o], round(total, 4)]
            for (w, s, o), total in intensity_sums.items()
            if o in idx_obs
        ),
        key=lambda row: (row[0], row[1], row[2]),
    )

    return {
        "options": {
            "farmStations": farm_stations,
            "pests":        pests,
            "diseases":     diseases,
            "stagesByObs":  {k: sorted(v) for k, v in stages_by_obs.items()},
        },
        "vocab": {
            "weeks":    vocab_weeks,
            "stations": vocab_stations,
            "obs":      vocab_obs,
            "stages":   vocab_stages,
        },
        "byAny":              by_any,
        "byKindName":         by_kn,
        "byKindNameStage":    by_kns,
        "scoutedByStation":   scouted,
        "intensityByStation": intensity,
        "stationsByFarm":     {f: sorted(s) for f, s in stations_by_farm.items()},
        "unitsByStation":     {s: len(u) for s, u in units_by_station.items()},
        "allWeeks":           vocab_weeks,
    }
