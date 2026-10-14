import type { PrevalenceFigures, Reliability, VarietyRow } from "@/lib/prevalence";

export interface ItemPercent { name: string; pct: number; zones: number }
/** Distribution / pressure row: `pct` is the adjusted prevalence (null when no
 *  house in scope has stations set up), `zones` the infested stations. */
export interface PrevalenceItem extends PrevalenceFigures {
  name: string; pct: number | null; zones: number;
}
export interface RankingRow extends PrevalenceFigures {
  name: string; total: number; high: number; moderate: number; low: number;
}
/** One ISO week of the trend line, dated on the week's Monday. */
export interface DailyPctRow {
  date: string; week?: string; value: number | null;
  margin?: number | null; reliability?: Reliability;
}
export interface TrendSeries {
  rows: Array<Record<string, string | number>>;
  keys: string[];
}

/** Stage options for the dashboard filter row.
 *
 *  `stages` is the flat union across every observation — right only while no
 *  specific pest/disease is picked. `stagesByItem` narrows it per observation,
 *  so choosing a pest stops the picker offering stages that pest never has.
 *  Optional because a payload cached before the server emitted it will lack it;
 *  consumers fall back to the flat list. */
export interface StageFilterOptions {
  sections: string[];
  stages: string[];
  stagesByItem?: Record<string, string[]>;
}

export interface PestsPayload {
  filterOptions: StageFilterOptions & { pests: string[] };
  ranking: RankingRow[];
  distribution: PrevalenceItem[];
  sectionSplit: ItemPercent[];
  greenhousePressure: PrevalenceItem[];
  dailyPercent: DailyPctRow[];
  trendSeries: TrendSeries;
  /** the selected pest by rose variety (S7); [] without a selected pest or variety */
  varieties?: VarietyRow[];
}

export interface DiseasesPayload extends Omit<PestsPayload, "filterOptions"> {
  filterOptions: StageFilterOptions & { diseases: string[] };
}

/** Stage options to offer for the currently-selected observation.
 *
 *  Falls back to the flat union when nothing is selected, when the payload
 *  predates `stagesByItem`, or when the selected item has no recorded stages —
 *  an empty picker would look broken. */
export function stagesFor(
  opts: StageFilterOptions,
  selected: string | undefined,
): string[] {
  if (!selected) return opts.stages;
  const narrowed = opts.stagesByItem?.[selected];
  return narrowed && narrowed.length ? narrowed : opts.stages;
}
