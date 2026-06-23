export interface OverviewKpis {
  totalScouts: number;
  zonesScouted: number;
  greenhouseCount: number;
  blockCount: number;
  highAlerts: number;
}

export interface OverviewDailyRow {
  date: string;
  pests: number;
  diseases: number;
  traps: number;
}

export interface GhHealthRow {
  name: string;
  pests: number;
  diseases: number;
  traps: number;
  scoutCount: number;
  alerts: number;
  status: "good" | "warning" | "critical";
}

export interface TopScout    { scoutId: string; entries: number }
export interface ScoutPerf   { scoutId: string; zones: number; pests: number; diseases: number }
export interface ScoutsDay   { date: string; scouts: number }
export interface RecentRow   {
  name: string; date: string; time: string;
  greenhouse: string; zone: string; scoutId: string;
  kind: "pest" | "disease" | "trap" | "other";
}
export interface ActiveAlert {
  name: string; kind: "pest" | "disease";
  severity: "high" | "moderate";
  count: number; greenhouse: string; zone: string; date: string;
}

export interface OverviewPayload {
  kpis: OverviewKpis;
  daily: OverviewDailyRow[];
  rangeTotals: { pests: number; diseases: number; traps: number };
  ghHealth: GhHealthRow[];
  topScouts: TopScout[];
  scoutsPerDay: ScoutsDay[];
  scoutPerformance: ScoutPerf[];
  recentActivity: RecentRow[];
  activeAlerts: ActiveAlert[];
}
