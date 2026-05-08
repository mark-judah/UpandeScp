import type { ScoutingEntry } from "@/lib/scouting-types";
import type { ObsKey, Selection, TreeNode } from "./trends-types";

export function stationOf(entry: ScoutingEntry): string {
  return (entry.block || entry.greenhouse || "").trim();
}

export function farmOf(
  station: string,
  greenhouseToFarm: Record<string, string>,
): string {
  return greenhouseToFarm[station] || "Unknown";
}

export interface OptionsBundle {
  farmStations: Record<string, Record<string, number>>;
  pests: Record<string, number>;
  diseases: Record<string, number>;
  stagesByObs: Record<string, Set<string>>;
}

export function gatherOptions(
  entries: ScoutingEntry[],
  greenhouseToFarm: Record<string, string>,
): OptionsBundle {
  const farmStations: Record<string, Record<string, number>> = {};
  const pests: Record<string, number> = {};
  const diseases: Record<string, number> = {};
  const stagesByObs: Record<string, Set<string>> = {};

  entries.forEach((e) => {
    const station = stationOf(e);
    const obsCount =
      e.pests_scouting_entry.length + e.diseases_scouting_entry.length;
    if (station && obsCount) {
      const farm = farmOf(station, greenhouseToFarm);
      if (!farmStations[farm]) farmStations[farm] = {};
      farmStations[farm][station] =
        (farmStations[farm][station] || 0) + obsCount;
    }
    e.pests_scouting_entry.forEach((p) => {
      const name = (p.pest || "").trim();
      if (!name) return;
      pests[name] = (pests[name] || 0) + 1;
      const key = `pest:${name}`;
      if (!stagesByObs[key]) stagesByObs[key] = new Set();
      if (p.stage) stagesByObs[key].add(p.stage);
    });
    e.diseases_scouting_entry.forEach((d) => {
      const name = (d.disease || "").trim();
      if (!name) return;
      diseases[name] = (diseases[name] || 0) + 1;
      const key = `disease:${name}`;
      if (!stagesByObs[key]) stagesByObs[key] = new Set();
      if (d.stage) stagesByObs[key].add(d.stage);
    });
  });

  return { farmStations, pests, diseases, stagesByObs };
}

export function buildStationTree(
  farmStations: Record<string, Record<string, number>>,
): TreeNode[] {
  return Object.keys(farmStations)
    .sort()
    .map((farm) => {
      const stations = farmStations[farm];
      const children = Object.keys(stations)
        .sort()
        .map((s) => ({
          id: `station:${farm}|${s}`,
          label: s,
          count: stations[s],
        }));
      return {
        id: `farm:${farm}`,
        label: farm,
        count: children.reduce((s, k) => s + (k.count || 0), 0),
        children,
      };
    });
}

export function buildObsTree(
  pests: Record<string, number>,
  diseases: Record<string, number>,
): TreeNode[] {
  const out: TreeNode[] = [];
  const pKeys = Object.keys(pests).sort();
  const dKeys = Object.keys(diseases).sort();
  if (pKeys.length) {
    out.push({
      id: "obs:group:pest",
      label: "Pests",
      count: pKeys.reduce((s, k) => s + (pests[k] || 0), 0),
      children: pKeys.map((k) => ({
        id: `obs:pest:${k}`,
        label: k,
        count: pests[k],
      })),
    });
  }
  if (dKeys.length) {
    out.push({
      id: "obs:group:disease",
      label: "Diseases",
      count: dKeys.reduce((s, k) => s + (diseases[k] || 0), 0),
      children: dKeys.map((k) => ({
        id: `obs:disease:${k}`,
        label: k,
        count: diseases[k],
      })),
    });
  }
  return out;
}

/** ID parsers — each tree row carries `farm:Name` or `station:Farm|Station`. */
export function parseSelection(id: string): Selection | null {
  if (id.startsWith("farm:")) {
    const farm = id.slice("farm:".length);
    return { kind: "farm", farm, label: farm };
  }
  if (id.startsWith("station:")) {
    const rest = id.slice("station:".length);
    const pipe = rest.indexOf("|");
    if (pipe < 0) return null;
    return {
      kind: "station",
      farm: rest.slice(0, pipe),
      station: rest.slice(pipe + 1),
      label: rest.slice(pipe + 1),
    };
  }
  return null;
}

export function parseObs(id: string): ObsKey | null {
  if (!id.startsWith("obs:") || id.startsWith("obs:group:")) return null;
  const rest = id.slice("obs:".length);
  const colon = rest.indexOf(":");
  if (colon < 0) return null;
  const kind = rest.slice(0, colon) as "pest" | "disease";
  const name = rest.slice(colon + 1);
  return { kind, name, label: name };
}

function unitKey(entry: ScoutingEntry): string {
  const block = (entry.block || "").trim();
  if (block) {
    const tree = (entry.tree || "").trim();
    if (!tree) return "";
    return `${block}::tree::${tree}`;
  }
  const zone = (entry.zone || "").trim();
  if (zone) return `zone::${zone}`;
  const bed = (entry.bed || "").trim();
  return bed ? `bed::${bed}` : "";
}

/* ============================================================
 * Pre-indexed entry view
 *
 * buildSeries is called once per chart panel × per stage drill-down. With a
 * naive nested loop it becomes O(stations × days × entries) which freezes
 * the page on multi-month ranges. We index once at the page level and pass
 * the cheap structure through to every panel.
 * ============================================================ */

export interface EntryIndex {
  /** station -> date -> list of entries on that date */
  byStationDate: Map<string, Map<string, ScoutingEntry[]>>;
  /** station -> Set of unit keys ever scouted in this period (denominator) */
  unitsByStation: Map<string, Set<string>>;
  /** stations grouped by farm (for farm-aggregate selections) */
  stationsByFarm: Map<string, string[]>;
  /** sorted dates that any of the indexed stations was scouted */
  allDates: string[];
}

export function buildEntryIndex(
  entries: ScoutingEntry[],
  greenhouseToFarm: Record<string, string>,
): EntryIndex {
  const byStationDate = new Map<string, Map<string, ScoutingEntry[]>>();
  const unitsByStation = new Map<string, Set<string>>();
  const stationsByFarm = new Map<string, Set<string>>();
  const dates = new Set<string>();

  for (const e of entries) {
    const stn = stationOf(e);
    const date = e.date_of_capture;
    if (!stn || !date) continue;

    let byDate = byStationDate.get(stn);
    if (!byDate) {
      byDate = new Map();
      byStationDate.set(stn, byDate);
    }
    let list = byDate.get(date);
    if (!list) {
      list = [];
      byDate.set(date, list);
    }
    list.push(e);

    const u = unitKey(e);
    if (u) {
      let set = unitsByStation.get(stn);
      if (!set) {
        set = new Set();
        unitsByStation.set(stn, set);
      }
      set.add(u);
    }

    const farm = farmOf(stn, greenhouseToFarm);
    let farmSet = stationsByFarm.get(farm);
    if (!farmSet) {
      farmSet = new Set();
      stationsByFarm.set(farm, farmSet);
    }
    farmSet.add(stn);

    dates.add(date);
  }

  return {
    byStationDate,
    unitsByStation,
    stationsByFarm: new Map(
      Array.from(stationsByFarm).map(([f, s]) => [f, Array.from(s).sort()]),
    ),
    allDates: Array.from(dates).sort(),
  };
}

function entryMatches(
  e: ScoutingEntry,
  obs: ObsKey | null,
  stage: string | null,
): boolean {
  if (!obs) {
    return (
      e.pests_scouting_entry.length > 0 || e.diseases_scouting_entry.length > 0
    );
  }
  if (obs.kind === "pest") {
    return e.pests_scouting_entry.some(
      (p) => p.pest === obs.name && (!stage || (p.stage || "") === stage),
    );
  }
  return e.diseases_scouting_entry.some(
    (d) => d.disease === obs.name && (!stage || (d.stage || "") === stage),
  );
}

/** Stations covered by a selection — single greenhouse or every greenhouse
 * in a farm. */
function stationsForSelection(
  sel: Selection,
  index: EntryIndex,
): string[] {
  if (sel.kind === "station") return [sel.station];
  return index.stationsByFarm.get(sel.farm) || [];
}

export interface DaySeriesPoint {
  date: string;
  [seriesLabel: string]: number | string | null;
}

/**
 * Total zones in the unit a selection covers.
 *
 * Source of truth is the ``zonesByGreenhouse`` map (Zone doctype counts via
 * ``get_zone_counts_by_greenhouse``). For a farm we sum across every
 * greenhouse the index has under that farm. Falls back to the in-period
 * scouted-units count if the structural map is missing for a station — the
 * data may not have all zones registered yet, so a fallback keeps the line
 * non-empty rather than dividing by zero.
 */
function denomForSelection(
  sel: Selection,
  index: EntryIndex,
  zonesByGreenhouse: Record<string, number>,
): number {
  const stations = stationsForSelection(sel, index);
  let total = 0;
  for (const stn of stations) {
    const fromMap = zonesByGreenhouse[stn];
    if (typeof fromMap === "number" && fromMap > 0) {
      total += fromMap;
    } else {
      // Fallback: distinct units scouted in the period — better than 0.
      total += index.unitsByStation.get(stn)?.size || 0;
    }
  }
  return total;
}

/**
 * Build the chart series data.
 *
 * Per scouted day, per ``Selection``:
 *   numerator   = distinct zones with the matching observation that day
 *   denominator = total zones structurally present in the unit
 *                 (sum of ``zonesByGreenhouse[gh]`` across the selection's
 *                  greenhouses; constant per selection, day-independent)
 *   value       = round(num / denom × 100)
 *
 * "No entry ≠ zero": a day where none of the selection's stations were
 * scouted returns **null**, so Recharts' ``connectNulls`` bridges the gap
 * and the line walks straight to the next scouted day rather than diving
 * to 0% on every quiet weekend.
 */
export function buildSeries(
  index: EntryIndex,
  selections: Selection[],
  obs: ObsKey | null,
  stage: string | null,
  zonesByGreenhouse: Record<string, number> = {},
): DaySeriesPoint[] {
  if (!selections.length || !index.allDates.length) return [];

  // Per-selection: list of stations + structural total-zones denominator.
  const selStations: string[][] = selections.map((sel) =>
    stationsForSelection(sel, index),
  );
  const selDenoms: number[] = selections.map((sel) =>
    denomForSelection(sel, index, zonesByGreenhouse),
  );

  return index.allDates.map((date) => {
    const point: DaySeriesPoint = { date };
    selections.forEach((sel, i) => {
      const stations = selStations[i];
      const denom = selDenoms[i];
      const matchedUnits = new Set<string>();

      for (const stn of stations) {
        const byDate = index.byStationDate.get(stn);
        if (!byDate) continue;
        const dayEntries = byDate.get(date);
        if (!dayEntries || !dayEntries.length) continue;
        for (const e of dayEntries) {
          if (!entryMatches(e, obs, stage)) continue;
          const u = unitKey(e);
          if (u) matchedUnits.add(u);
        }
      }

      // Skip rule: a day where this specific observation (and stage, if
      // drilled in) was not seen is a *gap* — connectNulls bridges to the
      // next "found it" day. Avoids the chart diving to 0% on quiet days.
      if (matchedUnits.size === 0) {
        point[sel.label] = null;
        return;
      }
      if (denom <= 0) {
        point[sel.label] = null;
        return;
      }
      const pct = (matchedUnits.size / denom) * 100;
      point[sel.label] = Math.round(pct * 10) / 10;
    });
    return point;
  });
}
