"""Trends page aggregator.

Replaces the per-week ``getScoutingEntriesChunk`` round-trip pattern that
made the Scouting Trends page slow. One cached call returns:

  * ``options``   — the picker trees (farms→stations, pests, diseases,
                    stagesByObs)
  * three flat **lookup tables** keyed by integer indices into ``vocab``:
      - ``byKindNameStage`` rows = ``[date, station, obs, stage, n]``
      - ``byKindName``      rows = ``[date, station, obs, n]``
      - ``byAny``           rows = ``[date, station, n]``
    where ``n`` is the count of distinct **unit keys** that match. Unit
    keys are station-prefixed (e.g. ``zone::Z1``, ``block::tree::T7``)
    so summing ``n`` across stations remains correct.
  * ``vocab`` — string arrays the indices resolve into
  * ``stationsByFarm`` / ``unitsByStation`` / ``allDates`` / ``zonesByGreenhouse``
    — the structural metadata the chart needs (denom, X-axis, farm rollup)

Cache key hashes (from_date, to_date, crop). 60s TTL. Realtime push will
expire the key promptly via the standard ``scp:scouting:dirty`` channel
once subscribers register; until then the TTL bounds staleness.
"""

import frappe

from upande_scp.serverscripts.scouting import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    parent_filter_conditions,
    publish_progress,
)


def trends(args: dict, force: bool = False) -> dict:
    from_date = args.get("from_date", "")
    to_date   = args.get("to_date", "")
    crop      = (args.get("crop") or "").strip()
    job_id    = (args.get("job_id") or "").strip()

    cache_filters = {"from_date": from_date, "to_date": to_date, "crop": crop}
    return cached_aggregate(
        "trends",
        cache_filters,
        lambda: _build(from_date, to_date, crop, job_id),
        force=force,
    )


def _build(from_date: str, to_date: str, crop: str, job_id: str = "") -> dict:
    publish_progress(job_id, 5, "resolving filters")
    where, params = parent_filter_conditions(from_date, to_date, crop, None)

    publish_progress(job_id, 25, "loading entries")
    rows = _fetch_observations(where, params)

    publish_progress(job_id, 70, "aggregating")
    payload = _aggregate(rows)

    publish_progress(job_id, 95, "loading unit counts")
    # Structural denominator per station, inferred from the warehouse type:
    # Greenhouse → Zones, Block → Orchard Trees (and a future type → Triads
    # for coffee). This is the total scouting units that *exist*, not the ones
    # that happened to be observed, so coverage % is correct for every crop.
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

    publish_progress(job_id, 100, "")
    return payload


def _fetch_observations(where: str, params: dict) -> list:
    """One row per (entry, observation kind, child row).

    Trends only graphs pests + diseases; traps live on a different
    dashboard tab so they're skipped here.
    """
    return frappe.db.sql(
        f"""
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               se.bed, se.zone, se.tree,
               'pest' AS kind,
               p.pest AS obs_name, p.stage AS stage
        FROM `tabScouting Entry` se
        JOIN `tabPests Scouting Entry` p ON p.parent = se.name
        WHERE {where}
        UNION ALL
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               se.bed, se.zone, se.tree,
               'disease' AS kind,
               d.disease AS obs_name, d.stage AS stage
        FROM `tabScouting Entry` se
        JOIN `tabDiseases Scouting Entry` d ON d.parent = se.name
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


def _aggregate(rows: list) -> dict:
    """Single pass over the observation rows produces:

      * options bundle (farmStations, pests, diseases, stagesByObs)
      * three lookup tables of distinct-unit counts
      * the structural metadata (stationsByFarm, unitsByStation, allDates)

    ``rows`` comes from a UNION ALL query with no ORDER BY, so its scan
    order is not defined. The grouping pass below keys everything by the
    actual date/station/obs/stage *strings* (not vocab indices), which
    makes the grouping itself immune to row order. Vocab indices are then
    assigned afterwards from sorted vocabularies, so which integer a given
    date/station/obs/stage gets — and the row order of byAny/byKindName/
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
    units_kns: dict[tuple, set] = {}  # (date, station, obs_key, stage) → {unit}
    units_kn:  dict[tuple, set] = {}  # (date, station, obs_key)       → {unit}
    units_any: dict[tuple, set] = {}  # (date, station)                → {unit}

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

        date = str(r.date_of_capture)[:10]
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

        units_any.setdefault((date, station), set()).add(unit)
        units_kn.setdefault((date, station, obs_key), set()).add(unit)
        units_kns.setdefault((date, station, obs_key, stage), set()).add(unit)

        stations_by_farm.setdefault(farm, set()).add(station)
        units_by_station.setdefault(station, set()).add(unit)

    # Vocabularies, sorted so index assignment doesn't depend on row scan
    # order. Index 0 in vocab_stages stays reserved for "no stage", as before.
    vocab_dates:    list[str] = sorted({d for (d, _s) in units_any})
    vocab_stations: list[str] = sorted({s for (_d, s) in units_any})
    vocab_obs:      list[str] = sorted({o for (_d, _s, o) in units_kn})
    vocab_stages:   list[str] = [""] + sorted({g for *_, g in units_kns if g})

    idx_dates    = {d: i for i, d in enumerate(vocab_dates)}
    idx_stations = {s: i for i, s in enumerate(vocab_stations)}
    idx_obs      = {o: i for i, o in enumerate(vocab_obs)}
    idx_stages   = {g: i for i, g in enumerate(vocab_stages)}

    by_any: list[list[int]] = sorted(
        ([idx_dates[d], idx_stations[s], len(u)] for (d, s), u in units_any.items()),
        key=lambda row: (row[0], row[1]),
    )
    by_kn: list[list[int]] = sorted(
        (
            [idx_dates[d], idx_stations[s], idx_obs[o], len(u)]
            for (d, s, o), u in units_kn.items()
        ),
        key=lambda row: (row[0], row[1], row[2]),
    )
    by_kns: list[list[int]] = sorted(
        (
            [idx_dates[d], idx_stations[s], idx_obs[o], idx_stages[g], len(u)]
            for (d, s, o, g), u in units_kns.items()
        ),
        key=lambda row: (row[0], row[1], row[2], row[3]),
    )

    return {
        "options": {
            "farmStations": farm_stations,
            "pests":        pests,
            "diseases":     diseases,
            "stagesByObs":  {k: sorted(v) for k, v in stages_by_obs.items()},
        },
        "vocab": {
            "dates":    vocab_dates,
            "stations": vocab_stations,
            "obs":      vocab_obs,
            "stages":   vocab_stages,
        },
        "byAny":           by_any,
        "byKindName":      by_kn,
        "byKindNameStage": by_kns,
        "stationsByFarm":  {f: sorted(s) for f, s in stations_by_farm.items()},
        "unitsByStation":  {s: len(u) for s, u in units_by_station.items()},
        "allDates":        sorted(vocab_dates),
    }
