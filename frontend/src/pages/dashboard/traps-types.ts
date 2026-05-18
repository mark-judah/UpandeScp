export interface TrapsPayload {
  ranking: Array<{ key: string; trap: string; pest: string; total: number; avg: number }>;
  pestBreakdown: Array<{ name: string; value: number }>;
  trendSeries: { rows: Array<Record<string, string | number>>; keys: string[] };
}
