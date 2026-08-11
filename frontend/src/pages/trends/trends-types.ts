export type TreeNode = {
  id: string;
  label: string;
  count?: number;
  children?: TreeNode[];
};

/** Picked items from the Stations tree. A farm selection means "aggregate
 * across this farm's greenhouses"; a station selection is a specific
 * greenhouse/block. */
export type Selection =
  | { kind: "farm"; farm: string; label: string }
  | { kind: "station"; farm: string; station: string; label: string };

export type ObsKey = { kind: "pest" | "disease"; name: string; label: string };

export type CheckState = "checked" | "indeterminate" | "unchecked";

/** Server payload — see _trends.py for the source of truth. The numeric
 * tuples in the three lookup tables index into ``vocab``; a separate
 * structure for each level of selectivity (any / kind+name / kind+name+stage)
 * avoids the overcount that would happen if the client summed across
 * stage rows it shouldn't be merging. */
export interface TrendsVocab {
  /** ISO-week bucket labels, e.g. "2026-W29". Zero-padded so plain sort is
   *  chronological. Weeks (not days) because that's the scouting cycle — a
   *  bucket then holds a near-complete sample of each station's units. */
  weeks: string[];
  stations: string[];
  obs: string[];   // "pest:Thrips", "disease:Powdery Mildew"
  stages: string[]; // index 0 is the empty-stage sentinel
}

export interface TrendsOptions {
  farmStations: Record<string, Record<string, number>>;
  pests: Record<string, number>;
  diseases: Record<string, number>;
  stagesByObs: Record<string, string[]>;
}

export interface TrendsPayload {
  options: TrendsOptions;
  vocab: TrendsVocab;
  /** rows: [weekIdx, stationIdx, n] — units with ANY observation */
  byAny: Array<[number, number, number]>;
  /** rows: [weekIdx, stationIdx, obsIdx, n] — the incidence NUMERATOR */
  byKindName: Array<[number, number, number, number]>;
  /** rows: [weekIdx, stationIdx, obsIdx, stageIdx, n] */
  byKindNameStage: Array<[number, number, number, number, number]>;
  /** rows: [weekIdx, stationIdx, n] — distinct units with any Scouting Entry in
   *  the bucket, clean ones included. **The incidence DENOMINATOR.** Cannot be
   *  derived from the tables above: those INNER JOIN the observation children,
   *  so a unit scouted and found clean contributes no row. */
  scoutedByStation: Array<[number, number, number]>;
  /** rows: [weekIdx, stationIdx, obsIdx, sumC] — pest-only intensity, where
   *  sumC is Σ over affected units of that unit's mean per-visit count.
   *  Diseases have no count column and are absent here. */
  intensityByStation: Array<[number, number, number, number]>;
  stationsByFarm: Record<string, string[]>;
  unitsByStation: Record<string, number>;
  allWeeks: string[];
  /** Structural total scouting units per station — Zones for greenhouses,
   *  Orchard Trees for blocks (and Triads for coffee).
   *
   *  The denominator of COVERAGE only. It used to be the denominator of the
   *  charted percentage, which made that percentage `incidence × coverage` —
   *  understating by 3.6–47.7× on real data and moving with scouting effort. */
  unitTotalsByStation: Record<string, number>;
  /** Crop's scouting-unit label inferred from warehouse type: "zone" |
   *  "tree" | "triad". */
  unitLabel: string;
  unitLabelPlural: string;
  /** Control actions keyed `"<week>|<station>"`. Lets the chart mark the weeks
   *  where something was actually DONE about a pest, beside the line showing
   *  whether it worked. Optional — a payload cached before this existed lacks
   *  it, and the overlay simply doesn't render. */
  sprayEvents?: Record<string, SprayEvent[]>;
}

export interface SprayEvent {
  /** YYYY-MM-DD of the work order's planned start */
  date: string;
  /** "Full" | "Top" | "Drench" | … ("" when unset) */
  sprayType: string;
  chemicals: string[];
  /** Active ingredients of those chemicals. Empty when none are recorded —
   *  populated for ~82% of real spray events. */
  ingredients: string[];
  /** Declared targets; entries match the pest/disease names on the chart, so
   *  an on-target spray can be told from an unrelated one. */
  targets: string[];
}
