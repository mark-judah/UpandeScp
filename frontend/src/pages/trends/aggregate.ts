import type {
  ObsKey,
  Selection,
  TreeNode,
  TrendsPayload,
  TrendsOptions,
} from "./trends-types";

/* =============================================================
 * Tree builders — picker UI input
 *
 * Backed by the ``options`` block on the server payload, so the
 * shape (farms → stations, pests/diseases lists, stages per obs)
 * is identical to what the previous client-side ``gatherOptions``
 * produced; only the source changed.
 * ============================================================= */

export function buildStationTree(
  farmStations: TrendsOptions["farmStations"],
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
  pests: TrendsOptions["pests"],
  diseases: TrendsOptions["diseases"],
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

/** ID parsers — each tree row carries ``farm:Name`` or ``station:Farm|Station``. */
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

/* =============================================================
 * Series builder
 *
 * The chart shows INCIDENCE: ``% of units SCOUTED that had the matching
 * observation``, per ISO week, per selection — where a "unit" is the crop's
 * scouting unit (zone for roses, orchard tree for avocado, triad for coffee).
 *
 *   numerator   = distinct units that matched in that week
 *   denominator = distinct units actually scouted in that week (scoutedByStation)
 *
 * The denominator used to be the structural unit total — every unit that
 * *exists* — so the plotted value was really ``incidence × coverage``. On real
 * data that understated by 3.6–47.7×, and because it scaled with how much
 * scouting happened, a week with fewer scouts read as an improvement. Coverage
 * is now reported separately (see ``cellStats``) instead of being silently
 * folded into the percentage.
 *
 * Unit keys are station-prefixed on the server (``block::tree::Tx``
 * or ``zone::Zy``) so summing the per-station ``n`` from a row stays
 * a correct distinct-unit count for the selection.
 * ============================================================= */

export interface DaySeriesPoint {
  date: string;
  [seriesLabel: string]: number | string | null;
}

export interface MatrixIndex {
  /** weekIdx → stationIdx → n (any obs) */
  any: Map<number, Map<number, number>>;
  /** weekIdx → stationIdx → obsIdx → n */
  kn: Map<number, Map<number, Map<number, number>>>;
  /** weekIdx → stationIdx → obsIdx → stageIdx → n */
  kns: Map<number, Map<number, Map<number, Map<number, number>>>>;
  /** weekIdx → stationIdx → units scouted (the incidence denominator) */
  scouted: Map<number, Map<number, number>>;
  /** weekIdx → stationIdx → obsIdx → Σ per-unit mean pest count */
  intensity: Map<number, Map<number, Map<number, number>>>;
  weekByIdx: string[];
  weekIdxByWeek: Map<string, number>;
  stationIdxByName: Map<string, number>;
  obsIdxByKey: Map<string, number>;
  stageIdxByName: Map<string, number>;
}

/** Build the fast-lookup index from the server payload — runs once per
 * payload (not per chart panel). Cheap: nested ``Map`` ops on a few
 * thousand rows at most. */
export function buildMatrixIndex(payload: TrendsPayload): MatrixIndex {
  const any = new Map<number, Map<number, number>>();
  for (const [d, s, n] of payload.byAny) {
    let row = any.get(d);
    if (!row) {
      row = new Map();
      any.set(d, row);
    }
    row.set(s, n);
  }

  const kn = new Map<number, Map<number, Map<number, number>>>();
  for (const [d, s, o, n] of payload.byKindName) {
    let stnMap = kn.get(d);
    if (!stnMap) {
      stnMap = new Map();
      kn.set(d, stnMap);
    }
    let obsMap = stnMap.get(s);
    if (!obsMap) {
      obsMap = new Map();
      stnMap.set(s, obsMap);
    }
    obsMap.set(o, n);
  }

  const kns = new Map<number, Map<number, Map<number, Map<number, number>>>>();
  for (const [d, s, o, g, n] of payload.byKindNameStage) {
    let stnMap = kns.get(d);
    if (!stnMap) {
      stnMap = new Map();
      kns.set(d, stnMap);
    }
    let obsMap = stnMap.get(s);
    if (!obsMap) {
      obsMap = new Map();
      stnMap.set(s, obsMap);
    }
    let stageMap = obsMap.get(o);
    if (!stageMap) {
      stageMap = new Map();
      obsMap.set(o, stageMap);
    }
    stageMap.set(g, n);
  }

  // Incidence denominator: weekIdx → stationIdx → units scouted.
  const scouted = new Map<number, Map<number, number>>();
  for (const [w, s, n] of payload.scoutedByStation ?? []) {
    let row = scouted.get(w);
    if (!row) {
      row = new Map();
      scouted.set(w, row);
    }
    row.set(s, n);
  }

  // Pest intensity: weekIdx → stationIdx → obsIdx → Σ per-unit mean count.
  const intensity = new Map<number, Map<number, Map<number, number>>>();
  for (const [w, s, o, c] of payload.intensityByStation ?? []) {
    let stnMap = intensity.get(w);
    if (!stnMap) {
      stnMap = new Map();
      intensity.set(w, stnMap);
    }
    let obsMap = stnMap.get(s);
    if (!obsMap) {
      obsMap = new Map();
      stnMap.set(s, obsMap);
    }
    obsMap.set(o, c);
  }

  const weekIdxByWeek = new Map(payload.vocab.weeks.map((w, i) => [w, i]));
  const stationIdxByName = new Map(
    payload.vocab.stations.map((s, i) => [s, i]),
  );
  const obsIdxByKey = new Map(payload.vocab.obs.map((o, i) => [o, i]));
  const stageIdxByName = new Map(
    payload.vocab.stages.map((g, i) => [g, i]),
  );

  return {
    any,
    kn,
    kns,
    scouted,
    intensity,
    weekByIdx: payload.vocab.weeks,
    weekIdxByWeek,
    stationIdxByName,
    obsIdxByKey,
    stageIdxByName,
  };
}

function stationsForSelection(
  sel: Selection,
  stationsByFarm: Record<string, string[]>,
): string[] {
  if (sel.kind === "station") return [sel.station];
  return (stationsByFarm ?? {})[sel.farm] || [];
}

/** Minimum units scouted before a bucket is allowed to produce a percentage.
 *
 *  2 affected out of 3 scouted is 67%, which plots identically to 683/843 and
 *  reads as a crisis. A gap is more honest than a number built on three zones;
 *  the chart's ``connectNulls`` already bridges it. */
export const DEFAULT_MIN_SAMPLE = 10;

/** Units actually scouted in this bucket for this selection — **the incidence
 *  denominator**.
 *
 *  Unit keys are station-prefixed server-side, so summing per-station counts is
 *  a correct distinct-unit count for a multi-station (farm) selection.
 *
 *  This replaced a sum of ``unitTotalsByStation`` (every unit that *exists*).
 *  That made the charted value ``incidence × coverage``: understated 3.6–47.7×
 *  on real data and — far worse — it moved with scouting effort, so a week with
 *  fewer scouts looked like an improvement. */
function scoutedForCell(
  index: MatrixIndex,
  weekIdx: number,
  stationIdxs: number[],
): number {
  const row = index.scouted.get(weekIdx);
  if (!row) return 0;
  let total = 0;
  for (const sIdx of stationIdxs) total += row.get(sIdx) || 0;
  return total;
}

/** Structural units in the selection — the COVERAGE denominator. */
export function structuralUnitsForSelection(
  sel: Selection,
  stationsByFarm: Record<string, string[]>,
  unitTotalsByStation: Record<string, number> | undefined,
): number {
  const totals = unitTotalsByStation ?? {};
  let total = 0;
  for (const stn of stationsForSelection(sel, stationsByFarm)) {
    total += totals[stn] || 0;
  }
  return total;
}

/** Numerator: sum of per-(date, station) distinct unit counts.
 *
 * Picks the most selective lookup table available:
 *   * obs+stage → kns table
 *   * obs only  → kn  table
 *   * no obs    → any table
 *
 * Each table already deduped unit keys server-side, so summing across
 * stations is the same as a distinct-unit count for the selection. */
function numeratorForCell(
  index: MatrixIndex,
  dateIdx: number,
  stationIdxs: number[],
  obsIdx: number | null,
  stageIdx: number | null,
): number {
  let total = 0;
  if (obsIdx === null) {
    const stn = index.any.get(dateIdx);
    if (!stn) return 0;
    for (const sIdx of stationIdxs) total += stn.get(sIdx) || 0;
    return total;
  }
  if (stageIdx === null || stageIdx === 0) {
    const stn = index.kn.get(dateIdx);
    if (!stn) return 0;
    for (const sIdx of stationIdxs) {
      const obs = stn.get(sIdx);
      if (!obs) continue;
      total += obs.get(obsIdx) || 0;
    }
    return total;
  }
  const stn = index.kns.get(dateIdx);
  if (!stn) return 0;
  for (const sIdx of stationIdxs) {
    const obs = stn.get(sIdx);
    if (!obs) continue;
    const stages = obs.get(obsIdx);
    if (!stages) continue;
    total += stages.get(stageIdx) || 0;
  }
  return total;
}

export function buildSeries(
  payload: TrendsPayload,
  index: MatrixIndex,
  selections: Selection[],
  obs: ObsKey | null,
  stage: string | null,
  minSample: number = DEFAULT_MIN_SAMPLE,
): DaySeriesPoint[] {
  if (!selections.length || !payload.allWeeks.length) return [];

  const obsKey = obs ? `${obs.kind}:${obs.name}` : null;
  const obsIdx = obsKey ? index.obsIdxByKey.get(obsKey) ?? null : null;
  const stageIdx = stage ? index.stageIdxByName.get(stage) ?? null : null;

  // The server never indexed this (obs, stage) pair, so nothing matches
  // — every point becomes null and the chart shows a flat empty line.
  if (obs && obsIdx === null) {
    return payload.allWeeks.map((date) => {
      const point: DaySeriesPoint = { date };
      for (const sel of selections) point[sel.label] = null;
      return point;
    });
  }

  const selStationIdxs: number[][] = selections.map((sel) =>
    stationsForSelection(sel, payload.stationsByFarm)
      .map((stn) => index.stationIdxByName.get(stn))
      .filter((i): i is number => typeof i === "number"),
  );

  return payload.allWeeks.map((week) => {
    const point: DaySeriesPoint = { date: week };
    const weekIdx = index.weekIdxByWeek.get(week);
    if (typeof weekIdx !== "number") {
      for (const sel of selections) point[sel.label] = null;
      return point;
    }
    selections.forEach((sel, i) => {
      // Denominator is per-BUCKET, not a constant: how many units were actually
      // scouted in this week for this selection.
      const denom = scoutedForCell(index, weekIdx, selStationIdxs[i]);
      const num = numeratorForCell(
        index,
        weekIdx,
        selStationIdxs[i],
        obsIdx,
        stageIdx,
      );
      if (denom < minSample) {
        // Too small a sample to state a percentage — a gap, not a spike.
        point[sel.label] = null;
      } else if (num === 0) {
        // Genuinely zero on a real sample. Kept as a gap (not 0) to preserve the
        // existing connectNulls look rather than dropping the line to the axis.
        point[sel.label] = null;
      } else {
        point[sel.label] = Math.round(((num / denom) * 100) * 10) / 10;
      }
    });
    return point;
  });
}

/** Per-bucket audit numbers behind one plotted point: the numerator, the sample
 *  size, and how much of the selection that sample represents. Drives the
 *  tooltip so every percentage on the page can be checked by eye. */
export interface CellStats {
  affected: number;
  scouted: number;
  structural: number;
  /** 100 × scouted / structural, or null when the structural count is unknown */
  coveragePct: number | null;
  /** Σ per-unit mean pest count; null for diseases (no count column) */
  intensitySum: number | null;
  /** intensitySum / scouted — mean pests per unit scouted */
  pressure: number | null;
  /** intensitySum / affected — mean pests where present */
  severity: number | null;
  suppressed: boolean;
}

export function cellStats(
  payload: TrendsPayload,
  index: MatrixIndex,
  sel: Selection,
  week: string,
  obs: ObsKey | null,
  stage: string | null,
  minSample: number = DEFAULT_MIN_SAMPLE,
): CellStats | null {
  const weekIdx = index.weekIdxByWeek.get(week);
  if (typeof weekIdx !== "number") return null;

  const stationIdxs = stationsForSelection(sel, payload.stationsByFarm)
    .map((stn) => index.stationIdxByName.get(stn))
    .filter((i): i is number => typeof i === "number");

  const obsKey = obs ? `${obs.kind}:${obs.name}` : null;
  const obsIdx = obsKey ? index.obsIdxByKey.get(obsKey) ?? null : null;
  const stageIdx = stage ? index.stageIdxByName.get(stage) ?? null : null;

  const scouted = scoutedForCell(index, weekIdx, stationIdxs);
  const affected = numeratorForCell(index, weekIdx, stationIdxs, obsIdx, stageIdx);
  const structural = structuralUnitsForSelection(
    sel,
    payload.stationsByFarm,
    payload.unitTotalsByStation,
  );

  let intensitySum: number | null = null;
  if (obsIdx !== null && obs?.kind === "pest") {
    const stnMap = index.intensity.get(weekIdx);
    if (stnMap) {
      let sum = 0;
      let seen = false;
      for (const sIdx of stationIdxs) {
        const v = stnMap.get(sIdx)?.get(obsIdx);
        if (typeof v === "number") {
          sum += v;
          seen = true;
        }
      }
      if (seen) intensitySum = sum;
    }
  }

  return {
    affected,
    scouted,
    structural,
    coveragePct: structural > 0 ? (scouted / structural) * 100 : null,
    intensitySum,
    pressure: intensitySum !== null && scouted > 0 ? intensitySum / scouted : null,
    severity: intensitySum !== null && affected > 0 ? intensitySum / affected : null,
    suppressed: scouted < minSample,
  };
}
