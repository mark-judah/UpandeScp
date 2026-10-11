/**
 * The weekly scout plan (spec C3–C7).
 * Backend: upande_scp.serverscripts.scouts.scout_plan.{get_scout_plan, save_scout_plan}.
 */
import { call } from "./frappe";

export type AssignmentStatus = "Planned" | "Done" | "Missed" | "On leave";
export type LeaveDay = "on_leave" | "leave_pending";

export interface PlanScout {
  scout: string;
  name: string;
  image: string;
  user: string | null;
  /** entries logged on this farm in the last four weeks */
  entries: number;
  active: boolean;
}

export interface PlanRow {
  date: string;
  scout: string;
  greenhouse: string;
  notes?: string;
}

export interface PlanAssignment extends PlanRow {
  name?: string;
  scoutName?: string;
  status?: AssignmentStatus;
}

export interface PlanActual extends PlanRow {
  entries: number;
}

export interface WeeklyCheck {
  unplanned: string[];
  median: number;
  load: Array<{ scout: string; houseDays: number; diff: number; flag: "high" | "low" | null }>;
  conflicts: Array<{ scout: string; date: string; farms: string[] }>;
  /** planned house-days whose scout is now on approved leave — reassign (C9) */
  onLeave: Array<{ scout: string; date: string; greenhouse: string }>;
}

export interface ScoutPlan {
  crop: string;
  farm: string;
  farms: string[];
  weekStart: string;
  weekEnd: string;
  days: string[];
  today: string;
  canEdit: boolean;
  greenhouses: string[];
  scouts: PlanScout[];
  assignments: PlanAssignment[];
  actuals: PlanActual[];
  unplanned: PlanActual[];
  lastWeek: { assignments: PlanRow[]; actuals: PlanActual[] };
  /** scout → { yyyy-mm-dd: on_leave | leave_pending } */
  leaves: Record<string, Record<string, LeaveDay>>;
  /** the same scouts' assignments on other farms this week */
  elsewhere: Array<{ date: string; scout: string; farm: string }>;
  check: WeeklyCheck;
  warnings?: string[];
  saved?: number;
}

const BASE = "upande_scp.serverscripts.scouts.scout_plan";

export function fetchScoutPlan(args: { crop?: string; farm?: string; week_start: string }): Promise<ScoutPlan> {
  return call<ScoutPlan>(`${BASE}.get_scout_plan`, {
    crop: args.crop || undefined,
    farm: args.farm || undefined,
    week_start: args.week_start,
  });
}

export function saveScoutPlan(args: {
  crop?: string;
  farm: string;
  week_start: string;
  assignments: PlanRow[];
}): Promise<ScoutPlan> {
  return call<ScoutPlan>(`${BASE}.save_scout_plan`, {
    crop: args.crop || undefined,
    farm: args.farm,
    week_start: args.week_start,
    assignments: JSON.stringify(args.assignments),
  });
}
