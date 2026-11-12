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

  // — the extensive KPI view (supervisor_kpis.py) —
  image: string;
  /** primary farm (most plans) */
  farm: string | null;
  farms: string[];
  /** approved leave days inside the range */
  leave_days: number;
  completion_rate: number | null;
  late_amber: number;
  late_orange: number;
  late_red: number;
  late_past_cutoff: number;
  /** planned start to actual start; negative = early */
  median_start_delay_min: number | null;
  accountability_pct: number | null;
  median_mix_to_start_min: number | null;
  median_spray_min: number | null;
  greenhouses_sprayed: number;
  greenhouses_per_day: number | null;
  hectares: number;
  scan_plans_complete: number;
  scan_plans: number;
  offline_plans: number;
  online_plans: number;
  offline_share: number | null;
  tokens_held: number;
  tokens_partial: number;
  tokens_refused: number;
  median_sync_min: number | null;
  avg_team_size: number | null;
  member_days: number;
  absent_member_days: number;
  absence_rate: number | null;
  crew_warnings: number;
  postponements: number;
  compliance_warnings: number;
  compliance_overridden: number;
  compliance_awaiting: number;
  refusals: number;
  /** six 0-1 scores, null where there is nothing to judge by */
  radar: Record<RadarKey, number | null>;
  /** mean of the known radar axes, 0-100 */
  score: number | null;
  weeks: { week: number; plans: number; due: number; on_time: number; completed: number }[];
  events: SupervisorEvent[];
}

export type RadarKey = "punctuality" | "completion" | "accountability" | "sync" | "attendance" | "pace";

export interface SupervisorEvent {
  plan: string;
  greenhouse: string | null;
  farm: string | null;
  scheduled: string | null;
  started: string | null;
  outcome: "on_time" | "late" | "missed" | "never_started" | null;
  grade: "amber" | "orange" | "red" | "past_cutoff" | null;
  completed: boolean;
  delay_min: number | null;
  spray_min: number | null;
  acted_by: string[];
  flags: string[];
}

/** One farm's medians over its supervisors (primary farm). */
export interface SupervisorMedians {
  farm: string | null;
  supervisors: number;
  completion_rate: number | null;
  on_time_pct: number | null;
  median_start_delay_min: number | null;
  accountability_pct: number | null;
  median_mix_to_start_min: number | null;
  median_spray_min: number | null;
  greenhouses_per_day: number | null;
  offline_share: number | null;
  median_sync_min: number | null;
  avg_team_size: number | null;
  absence_rate: number | null;
  assigned: number | null;
  hectares: number | null;
  radar: Record<RadarKey, number | null>;
}

export interface SupervisorsPayload {
  from_date: string;
  to_date: string;
  grace_hours: number;
  plans: number;
  no_supervisor: number;
  rows: SupervisorRow[];
  medians: SupervisorMedians[];
  pace_ref_min: number | null;
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

/** The radar's axes in order, with the words the page uses. */
export const RADAR_AXES: { key: RadarKey; label: string }[] = [
  { key: "punctuality", label: "Punctuality" },
  { key: "completion", label: "Completion" },
  { key: "accountability", label: "Accountability" },
  { key: "sync", label: "Sync speed" },
  { key: "attendance", label: "Attendance" },
  { key: "pace", label: "Pace" },
];

export const median = (values: (number | null | undefined)[]): number | null => {
  const xs = values.filter((v): v is number => v != null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
};

/** Minutes as the reader wants them: "45 min", "2 h 10 min", "—". Negative = early. */
export function minutesText(v: number | null | undefined): string {
  if (v == null) return "—";
  const sign = v < 0 ? "−" : "";
  const m = Math.round(Math.abs(v));
  if (m < 60) return `${sign}${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${sign}${h} h${r ? ` ${r} min` : ""}`;
}

/** Splits the rows into the list's two groups: ranked (something was due) and the rest. */
export function splitRanked(rows: SupervisorRow[]) {
  return {
    ranked: rows.filter((r) => r.rank != null),
    unranked: rows.filter((r) => r.rank == null),
  };
}

/** The farm's medians for a supervisor's primary farm. */
export function medianFor(data: Pick<SupervisorsPayload, "medians"> | null, r: SupervisorRow | null) {
  return (r && data?.medians.find((m) => m.farm === r.farm)) || null;
}

/** Radar axes (0-1) for a supervisor, with readouts. */
export function radarAxes(r: SupervisorRow) {
  const pc = (v: number | null) => (v == null ? "—" : `${Math.round(v * 10) / 10}%`);
  const readout: Record<RadarKey, string> = {
    punctuality: `${pc(r.on_time_pct)} on time · ${r.late} late`,
    completion: `${pc(r.completion_rate)} · ${r.completed} of ${r.assigned}`,
    accountability: `${pc(r.accountability_pct)} scanned by them`,
    sync: r.median_sync_min == null ? "no offline sprays" : `${minutesText(r.median_sync_min)} to sync`,
    attendance: r.absence_rate == null ? "no check-in data" : `${pc(r.absence_rate)} absent`,
    pace: `${minutesText(r.median_spray_min)} per house`,
  };
  return RADAR_AXES.map((a) => ({
    key: a.key,
    label: a.label,
    value: r.radar?.[a.key] ?? null,
    readout: readout[a.key],
  }));
}

/** The farm median's radar, in axis order (0-1), for the dashed outline. */
export function benchmarkOf(m: SupervisorMedians | null): (number | null)[] {
  return RADAR_AXES.map((a) => m?.radar?.[a.key] ?? null);
}

export const OUTCOME_LABEL: Record<NonNullable<SupervisorEvent["outcome"]>, string> = {
  on_time: "Started on time",
  late: "Started late",
  missed: "Missed (started a later day)",
  never_started: "Never started",
};

export const GRADE_LABEL: Record<NonNullable<SupervisorEvent["grade"]>, string> = {
  amber: "amber",
  orange: "orange",
  red: "red",
  past_cutoff: "after the cutoff",
};

/** "2026-11-03 09:00:00" → "Nov 2026" (the feed's group heading). */
export function monthGroup(iso: string | null): string {
  if (!iso) return "No date";
  const d = new Date(iso.replace(" ", "T"));
  return Number.isNaN(d.getTime())
    ? "No date"
    : d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** The words for one plan event: what happened, then how far off. */
export function eventText(e: SupervisorEvent): { label: string; detail: string } {
  const where = e.greenhouse || e.plan;
  const what = e.outcome
    ? OUTCOME_LABEL[e.outcome]
    : e.completed
      ? "Completed"
      : e.started
        ? "Started"
        : "Planned";
  const bits: string[] = [];
  if (e.delay_min != null) {
    bits.push(e.delay_min < 0 ? `${minutesText(-e.delay_min)} early` : `${minutesText(e.delay_min)} after plan`);
  }
  if (e.grade) bits.push(`late grade ${GRADE_LABEL[e.grade]}`);
  if (e.spray_min != null) bits.push(`sprayed ${minutesText(e.spray_min)}`);
  bits.push(e.acted_by.length ? `scanned by ${e.acted_by.join(", ")}` : "nobody scanned");
  if (e.flags.length) bits.push(e.flags.join(", "));
  return { label: `${where} · ${what}`, detail: bits.join(" · ") };
}

/** Plans due per week, as the share started on time, for the trend bars. */
export function weekRate(w: { due: number; on_time: number }): number | null {
  return w.due ? (100 * w.on_time) / w.due : null;
}
