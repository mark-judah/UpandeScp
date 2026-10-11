/**
 * Personnel ▸ Teams and Sprayers endpoints.
 * Backend: upande_scp.serverscripts.sprayers.api
 * GM / System Manager act on their visible farms; an SCP Spray Supervisor or
 * SCP Spray Plan Creator on the farms they are rostered on. Enforced server-side.
 */
import { call } from "./frappe";

const API = "upande_scp.serverscripts.sprayers.api";

export type TeamRole = "Supervisor" | "Sprayer" | "Pump Operator";
export const TEAM_ROLES: TeamRole[] = ["Sprayer", "Pump Operator", "Supervisor"];

export interface TeamsContext {
  manager: boolean;
  farms: string[];
}

export interface TeamMember {
  employee: string;
  employee_name: string;
  designation?: string | null;
  status?: string | null;
  role: TeamRole;
  /** Employee.image — a Frappe file URL, empty when none is on file. */
  image?: string | null;
  /** the member's Sprayer ID, once the register has them */
  sprayer?: string | null;
}

export interface SprayTeam {
  name: string;
  team_name: string;
  enabled: 0 | 1;
  farm: string | null;
  members: TeamMember[];
}

export interface EmployeeHit {
  employee: string;
  employee_name: string;
  designation?: string | null;
  company?: string | null;
  image?: string | null;
}

export interface SprayerRow {
  name: string;
  employee: string;
  employee_name: string;
  farm: string | null;
  spray_team: string | null;
  role: string;
  status: "Active" | "Inactive";
  designation?: string | null;
  /** Employee.image — a Frappe file URL, empty when none is on file. */
  image?: string | null;
  hours_30d: number;
  weighted_30d: number;
  hours_total: number;
  weighted_total: number;
  last_exposure: string | null;
}

export interface ExposureFlags {
  rows: number;
  no_duration: number;
  hazard_unknown: number;
  /** distinct products behind the "hazard unknown" rows */
  products_unclassified: number;
}

export interface SprayersPayload {
  sprayers: SprayerRow[];
  flags: ExposureFlags;
}

export interface ProductExposure {
  spray_product: string | null;
  product_name: string;
  toxicity: string | null;
  hazard_weight: number;
  sessions: number;
  hours: number;
  weighted_hours: number;
  last_date: string | null;
}

export interface ExposureSession {
  logsheet: string;
  date: string;
  greenhouse: string | null;
  role: string;
  ppe_condition: string | null;
  hours: number;
  weighted_hours: number;
  products: string;
  /** distinct WHO classes of the session's products, "II, III" */
  toxicity?: string | null;
  hazard_weight?: number | null;
  flags: string | null;
}

export interface SprayerDetail {
  sprayer: SprayerRow;
  products: ProductExposure[];
  sessions: ExposureSession[];
}

const crop = (c?: string) => (c ? { crop: c } : {});

export const fetchTeamsContext = (c?: string) =>
  call<TeamsContext>(`${API}.get_context`, crop(c));

export const fetchSprayTeams = (c?: string) =>
  call<SprayTeam[]>(`${API}.get_spray_teams`, crop(c));

export const searchEmployees = (farm: string | null, txt: string, c?: string) =>
  call<EmployeeHit[]>(`${API}.search_employees`, { farm: farm || "", txt, ...crop(c) });

export const saveSprayTeam = (
  team: string,
  patch: { members?: { employee: string; role: TeamRole }[]; farm?: string | null; enabled?: boolean },
  c?: string,
) =>
  call<SprayTeam>(`${API}.save_spray_team`, {
    team,
    ...(patch.members ? { members: JSON.stringify(patch.members) } : {}),
    ...(patch.farm !== undefined ? { farm: patch.farm || "" } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled ? 1 : 0 } : {}),
    ...crop(c),
  });

export const fetchSprayers = (c?: string) =>
  call<SprayersPayload>(`${API}.get_sprayers`, crop(c));

export const fetchSprayerDetail = (sprayer: string, c?: string) =>
  call<SprayerDetail>(`${API}.get_sprayer_detail`, { sprayer, ...crop(c) });

export interface MemberLeaveSpan {
  from_date: string;
  to_date: string;
  /** approved = Leave Application submitted; pending = still Open */
  state: "approved" | "pending";
  leave_type: string | null;
  half_day: boolean;
}

export interface MemberLeave {
  /** on the window's first day (the plan date, else today) */
  status: "on_leave" | "leave_pending" | "ok";
  half_day: boolean;
  leave_type: string | null;
  leaves: MemberLeaveSpan[];
}

export interface MemberLeaveResult {
  from_date: string;
  to_date: string;
  members: Record<string, MemberLeave>;
}

/** Approved and pending leave for team members over the look-ahead window (default 14 days). */
export const fetchMemberLeave = (employees: string[], fromDate?: string, c?: string) =>
  call<MemberLeaveResult>(`${API}.get_member_leave`, {
    employees: JSON.stringify(employees),
    ...(fromDate ? { from_date: fromDate } : {}),
    ...crop(c),
  });
