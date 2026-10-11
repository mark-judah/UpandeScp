/**
 * Personnel ▸ Scouts payload (personnel spec P4, P5).
 * Backend: upande_scp.serverscripts.scouts.api.get_scouts — the quality
 * aggregate's scout rows, ranked by common/scout_ranking.py. Fetched through
 * useDashboardAggregate("scouts", …) so it gets the same progress bar.
 */
import type { QualityFlag, QualityScout } from "@/pages/dashboard/quality-types";

export interface ScoutRecord extends QualityScout {
  stationsPerDay: number | null;
  houses: { house: string; entries: number }[];
  weeks: { week: number; entries: number }[];
  lastDate: string | null;
  /** primary farm (most entries) first */
  farms: string[];
  farm: string | null;
  entriesPerDay: number | null;
  eligible: boolean;
  /** approved-leave days in the range — excused from the minimum (C9) */
  leaveDays?: number;
  /** active days this scout needs to be ranked: the minimum scaled to days not on leave */
  requiredDays?: number;
  image: string;
  flags: QualityFlag[];
  /** only on ranked scouts */
  rank?: number;
  score?: number;
  effort?: number;
  integrity?: number;
  gps?: number;
  gpsNote?: string | null;
}

export interface FarmMedians {
  farm: string | null;
  scouts: number;
  stationsPerDay: number | null;
  entriesPerDay: number | null;
  entriesPerHour: number | null;
  tooFastPct: number | null;
  duplicatePct: number | null;
  offZonePct: number | null;
  nothingFoundPct: number | null;
}

export interface ScoutsPayload {
  ranked: ScoutRecord[];
  notEnoughDays: ScoutRecord[];
  medians: FarmMedians[];
  /** the farm read ("" = every farm of the crop) */
  farm: string;
  farms: string[];
  allFarms: boolean;
  range: { from_date: string; to_date: string };
  clamped: boolean;
  weights: { effort: number; integrity: number; gps: number };
  minActiveDays: number;
  defaultRange: { from_date: string; to_date: string };
}

/** "202640" → "W40". */
export const weekLabel = (yw: number) => `W${String(yw % 100).padStart(2, "0")}`;

export function initialsOf(name: string): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** "on leave 3 days" — approved leave in the range, excused from ranking (C9). */
export function onLeaveText(days: number): string {
  const n = Number.isInteger(days) ? String(days) : days.toFixed(1);
  return `on leave ${n} ${days === 1 ? "day" : "days"}`;
}
