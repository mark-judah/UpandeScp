export interface FcmPayload {
  kpis: { trapTotal: number; pestTotal: number; focusZones: number;
          greenhouseCount: number };
  daily: Array<{ date: string; traps: number; scouting: number }>;
  pestBreakdown: Array<{ name: string; value: number }>;
  focusPests: Array<{ name: string; total: number }>;
}
