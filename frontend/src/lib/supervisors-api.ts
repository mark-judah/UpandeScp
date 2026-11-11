/**
 * Personnel ▸ Supervisors: how each spray supervisor did over a date range
 * (serverscripts/sprayers/supervisors.get_supervisors). The server does the
 * counting; the browser formats it.
 */
import { call } from "./frappe";

export interface SupervisorRow {
  employee: string;
  name: string;
  rank: number | null;
  /** plans whose team names them supervisor */
  assigned: number;
  /** of those, scanned / started by them */
  acted: number;
  /** of those, scanned / started by someone else */
  by_other: number;
  /** of those, nobody scanned */
  nobody: number;
  completed: number;
  /** plans whose time has passed (the four outcomes below add up to it) */
  due: number;
  on_time: number;
  late: number;
  missed: number;
  never_started: number;
  on_time_pct: number | null;
  /** plans they scanned / started that were another supervisor's */
  covered_for_others: number;
}

export interface SupervisorsPayload {
  from_date: string;
  to_date: string;
  grace_hours: number;
  plans: number;
  no_supervisor: number;
  rows: SupervisorRow[];
  farms: string[];
  farm: string;
}

export function fetchSupervisors(args: {
  crop?: string;
  farm?: string;
  from_date?: string;
  to_date?: string;
}): Promise<SupervisorsPayload> {
  return call<SupervisorsPayload>(
    "upande_scp.serverscripts.sprayers.supervisors.get_supervisors",
    args,
  );
}
