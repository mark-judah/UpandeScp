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
  dates: string[];
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
  /** rows: [dateIdx, stationIdx, n] */
  byAny: Array<[number, number, number]>;
  /** rows: [dateIdx, stationIdx, obsIdx, n] */
  byKindName: Array<[number, number, number, number]>;
  /** rows: [dateIdx, stationIdx, obsIdx, stageIdx, n] */
  byKindNameStage: Array<[number, number, number, number, number]>;
  stationsByFarm: Record<string, string[]>;
  unitsByStation: Record<string, number>;
  allDates: string[];
  zonesByGreenhouse: Record<string, number>;
}
