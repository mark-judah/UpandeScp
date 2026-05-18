export interface ItemPercent { name: string; pct: number; zones: number }
export interface RankingRow  { name: string; total: number; high: number;
                                moderate: number; low: number }
export interface DailyPctRow { date: string; value: number }
export interface TrendSeries {
  rows: Array<Record<string, string | number>>;
  keys: string[];
}

export interface PestsPayload {
  filterOptions: { pests: string[]; sections: string[]; stages: string[] };
  ranking: RankingRow[];
  distribution: ItemPercent[];
  sectionSplit: ItemPercent[];
  greenhousePressure: ItemPercent[];
  dailyPercent: DailyPctRow[];
  trendSeries: TrendSeries;
}

export interface DiseasesPayload extends Omit<PestsPayload, "filterOptions"> {
  filterOptions: { diseases: string[]; sections: string[]; stages: string[] };
}
