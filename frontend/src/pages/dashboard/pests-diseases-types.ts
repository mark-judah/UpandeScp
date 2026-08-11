export interface ItemPercent { name: string; pct: number; zones: number }
export interface RankingRow  { name: string; total: number; high: number;
                                moderate: number; low: number }
export interface DailyPctRow { date: string; value: number }
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
  distribution: ItemPercent[];
  sectionSplit: ItemPercent[];
  greenhousePressure: ItemPercent[];
  dailyPercent: DailyPctRow[];
  trendSeries: TrendSeries;
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
