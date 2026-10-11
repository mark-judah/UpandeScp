/**
 * Teams & KPIs page endpoints.
 * Backend: upande_scp.serverscripts.sprayers.api
 * GM / System Manager act on their visible farms; an SCP Spray Supervisor on
 * the farms they are rostered on. Enforced server-side.
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
