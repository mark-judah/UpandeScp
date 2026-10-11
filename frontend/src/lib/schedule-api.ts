/**
 * Client for the spray Schedule page and the crew availability badges.
 *
 *  - ``schedule.get_schedule``               — plans, crews and crew leave in a range.
 *  - ``spray_session.get_crew_availability`` — per-member status on a date.
 */
import { call } from "./frappe";

export type CrewStatus = "on_leave" | "leave_pending" | "not_checked_in" | "ok";
export type LeaveCheckMode = "Off" | "Warn" | "Block";

export const CREW_STATUS_LABEL: Record<CrewStatus, string> = {
  on_leave: "On leave",
  leave_pending: "Leave pending",
  not_checked_in: "Not clocked in",
  ok: "Available",
};

export interface CrewMemberAvailability {
  status: CrewStatus;
  label: string;
  half_day: boolean;
  leave_application: string | null;
  leave_type: string | null;
  employee_name: string;
}

export interface CrewAvailability {
  mode: LeaveCheckMode;
  require_checkin: boolean;
  on_date: string;
  members: Record<string, CrewMemberAvailability>;
}

export async function fetchCrewAvailability(args: {
  work_order?: string;
  employees?: string[];
  on_date?: string;
}): Promise<CrewAvailability> {
  return call<CrewAvailability>(
    "upande_scp.serverscripts.spray_plan_creator.spray_session.get_crew_availability",
    {
      work_order: args.work_order,
      employees: args.employees ? JSON.stringify(args.employees) : undefined,
      on_date: args.on_date,
    },
  );
}

export interface ScheduleCrewMember {
  employee: string;
  employee_name: string;
  role: string;
  status: CrewStatus;
  half_day: boolean;
}

export interface SchedulePlan {
  name: string;
  greenhouse: string;
  farm: string | null;
  team: string;
  workflow_state: string;
  spray_type: string | null;
  planned_start: string | null;
  actual_start: string | null;
  actual_end: string | null;
  /** yyyy-mm-dd: the planned day */
  start: string | null;
  /** yyyy-mm-dd: the actual end day, or the planned day when not ended */
  end: string | null;
  crew: ScheduleCrewMember[];
  on_leave_count: number;
  pending_count: number;
}

export interface ScheduleLeave {
  name: string;
  employee: string;
  employee_name: string;
  leave_type: string | null;
  from_date: string;
  to_date: string;
  half_day: boolean;
  status: "approved" | "pending";
  /** the teams this person sprayed with in the range */
  teams: string[];
}

export interface Schedule {
  from_date: string;
  to_date: string;
  crop: string | null;
  farms: string[];
  teams: string[];
  states: string[];
  plans: SchedulePlan[];
  leaves: ScheduleLeave[];
  latest_plan_date: string | null;
  leave_check: LeaveCheckMode;
}

export async function fetchSchedule(args: {
  crop?: string;
  farm?: string;
  from_date: string;
  to_date: string;
  team?: string;
  state?: string;
}): Promise<Schedule> {
  return call<Schedule>("upande_scp.serverscripts.spray_plan_ops.schedule.get_schedule", {
    crop: args.crop || undefined,
    farm: args.farm || undefined,
    from_date: args.from_date,
    to_date: args.to_date,
    team: args.team || undefined,
    state: args.state || undefined,
  });
}
