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
 * The chart shows ``% units with the matching observation`` per day, per
 * selection — where a "unit" is the crop's scouting unit (zone for roses).
 * The numerator is the count of
 * distinct unit keys that matched on that day; the denominator is the
 * structural total units of the selection (sum of unitTotalsByStation across
 * covered stations).
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
  /** dateIdx → stationIdx → n (any obs) */
  any: Map<number, Map<number, number>>;
  /** dateIdx → stationIdx → obsIdx → n */
  kn: Map<number, Map<number, Map<number, number>>>;
  /** dateIdx → stationIdx → obsIdx → stageIdx → n */
  kns: Map<number, Map<number, Map<number, Map<number, number>>>>;
  dateByIdx: string[];
  dateIdxByDate: Map<string, number>;
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

  const dateIdxByDate = new Map(payload.vocab.dates.map((d, i) => [d, i]));
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
    dateByIdx: payload.vocab.dates,
    dateIdxByDate,
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

function denomForSelection(
  sel: Selection,
  stationsByFarm: Record<string, string[]>,
  unitTotalsByStation: Record<string, number> | undefined,
  unitsByStation: Record<string, number> | undefined,
): number {
  const stations = stationsForSelection(sel, stationsByFarm);
  // Default to empty maps so an older/partial payload (e.g. a cached one from
  // before unitTotalsByStation existed) degrades to the observed-unit fallback
  // instead of throwing and blanking the page.
  const totals = unitTotalsByStation ?? {};
  const observed = unitsByStation ?? {};
  let total = 0;
  for (const stn of stations) {
    // Structural total units for the station (zones / trees / triads per
    // warehouse type). Falls back to observed units when the station has no
    // structural count yet.
    const fromMap = totals[stn];
    if (typeof fromMap === "number" && fromMap > 0) {
      total += fromMap;
    } else {
      total += observed[stn] || 0;
    }
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
): DaySeriesPoint[] {
  if (!selections.length || !payload.allDates.length) return [];

  const obsKey = obs ? `${obs.kind}:${obs.name}` : null;
  const obsIdx = obsKey ? index.obsIdxByKey.get(obsKey) ?? null : null;
  const stageIdx = stage ? index.stageIdxByName.get(stage) ?? null : null;

  // The server never indexed this (obs, stage) pair, so nothing matches
  // — every day point becomes null and the chart shows a flat empty line.
  if (obs && obsIdx === null) {
    return payload.allDates.map((date) => {
      const point: DaySeriesPoint = { date };
      for (const sel of selections) point[sel.label] = null;
      return point;
    });
  }

  // Per-selection: station-index list and structural denominator.
  const selStationIdxs: number[][] = selections.map((sel) =>
    stationsForSelection(sel, payload.stationsByFarm)
      .map((stn) => index.stationIdxByName.get(stn))
      .filter((i): i is number => typeof i === "number"),
  );
  const selDenoms: number[] = selections.map((sel) =>
    denomForSelection(
      sel,
      payload.stationsByFarm,
      payload.unitTotalsByStation,
      payload.unitsByStation,
    ),
  );

  return payload.allDates.map((date) => {
    const point: DaySeriesPoint = { date };
    const dateIdx = index.dateIdxByDate.get(date);
    if (typeof dateIdx !== "number") {
      for (const sel of selections) point[sel.label] = null;
      return point;
    }
    selections.forEach((sel, i) => {
      const denom = selDenoms[i];
      const num = numeratorForCell(
        index,
        dateIdx,
        selStationIdxs[i],
        obsIdx,
        stageIdx,
      );
      if (num === 0 || denom <= 0) {
        // Treat a "no match" day as a gap — connectNulls bridges it.
        point[sel.label] = null;
      } else {
        point[sel.label] = Math.round(((num / denom) * 100) * 10) / 10;
      }
    });
    return point;
  });
}
