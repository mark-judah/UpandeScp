/**
 * Pure helpers for the Scout plan grid: editing the draft week, the leave rule,
 * Copy last week, plan-vs-actual, and the weekly check. The check mirrors
 * `common/scout_plan_rules.weekly_check` so it follows unsaved edits live.
 */
import { addDays, format } from "date-fns";
import type { AssignmentStatus, PlanActual, PlanRow, ScoutPlan, WeeklyCheck } from "@/lib/scout-plan-api";
import { day } from "./schedule-utils";

export const LOAD_TOLERANCE = 0.5;

export const rowKey = (r: Pick<PlanRow, "date" | "scout" | "greenhouse">) =>
  `${r.date}|${r.scout}|${r.greenhouse}`;

export type AddResult = { rows: PlanRow[]; error?: string; warning?: string };

/** Add one assignment. Approved leave refuses; pending leave warns; a repeat is a no-op. */
export function addAssignment(
  rows: PlanRow[],
  row: PlanRow,
  leaves: ScoutPlan["leaves"],
  scoutName = row.scout,
): AddResult {
  const leave = leaves[row.scout]?.[row.date];
  if (leave === "on_leave") {
    return { rows, error: `${scoutName} is on approved leave on ${row.date}.` };
  }
  if (rows.some((r) => rowKey(r) === rowKey(row))) return { rows };
  const next = [...rows, { date: row.date, scout: row.scout, greenhouse: row.greenhouse }];
  return leave === "leave_pending"
    ? { rows: next, warning: `${scoutName} has a leave application pending for ${row.date}.` }
    : { rows: next };
}

export function removeAssignment(rows: PlanRow[], row: PlanRow): PlanRow[] {
  const k = rowKey(row);
  return rows.filter((r) => rowKey(r) !== k);
}

/**
 * Last week moved seven days on: last week's plan when there was one, else what was
 * actually scouted. Houses outside the farm and scouts on approved leave that day
 * are dropped (and counted).
 */
export function copyLastWeek(plan: Pick<ScoutPlan, "lastWeek" | "greenhouses" | "leaves">): {
  rows: PlanRow[];
  source: "plan" | "actuals";
  skippedLeave: number;
} {
  const source = plan.lastWeek.assignments.length ? "plan" : "actuals";
  const from: PlanRow[] = source === "plan" ? plan.lastWeek.assignments : plan.lastWeek.actuals;
  const houses = new Set(plan.greenhouses);
  const seen = new Set<string>();
  const rows: PlanRow[] = [];
  let skippedLeave = 0;
  for (const r of from) {
    if (!houses.has(r.greenhouse)) continue;
    const moved = { date: format(addDays(day(r.date), 7), "yyyy-MM-dd"), scout: r.scout, greenhouse: r.greenhouse };
    if (plan.leaves[moved.scout]?.[moved.date] === "on_leave") {
      skippedLeave++;
      continue;
    }
    const k = rowKey(moved);
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push(moved);
  }
  return { rows, source, skippedLeave };
}

/**
 * Done as soon as the entries exist; On leave when approved leave covers the day
 * (leave approved after the plan — not the scout's miss); Missed once the day is over.
 */
export function statusFor(
  row: PlanRow,
  actuals: PlanActual[],
  today: string,
  leaves: ScoutPlan["leaves"] = {},
): AssignmentStatus {
  if (actuals.some((a) => rowKey(a) === rowKey(row))) return "Done";
  if (leaves[row.scout]?.[row.date] === "on_leave") return "On leave";
  return row.date < today ? "Missed" : "Planned";
}

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * "Leave Tue–Thu", "Leave Mon, Wed", "Pending Fri" — a scout's leave days in the
 * week for the picker. Consecutive days collapse to a range.
 */
export function leaveNote(days: string[], byDate: Record<string, string> | undefined): string {
  if (!byDate) return "";
  const part = (kind: string) => {
    const idx = days.map((d, i) => (byDate[d] === kind ? i : -1)).filter((i) => i >= 0);
    const runs: string[] = [];
    for (let k = 0; k < idx.length; ) {
      let j = k;
      while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
      runs.push(j > k ? `${DOW[idx[k]]}–${DOW[idx[j]]}` : DOW[idx[k]]);
      k = j + 1;
    }
    return runs.join(", ");
  };
  const approved = part("on_leave");
  const pending = part("leave_pending");
  return [approved && `Leave ${approved}`, pending && `Pending ${pending}`].filter(Boolean).join(" · ");
}

export function unplannedActuals(actuals: PlanActual[], rows: PlanRow[]): PlanActual[] {
  const planned = new Set(rows.map(rowKey));
  return actuals.filter((a) => !planned.has(rowKey(a)));
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function weeklyCheck(
  houses: string[],
  rows: PlanRow[],
  elsewhere: ScoutPlan["elsewhere"] = [],
  farm?: string,
  leaves: ScoutPlan["leaves"] = {},
): WeeklyCheck {
  const planned = new Set(rows.map((r) => r.greenhouse));
  const unplanned = houses.filter((h) => !planned.has(h));
  const houseDays = new Map<string, Set<string>>();
  for (const r of rows) {
    const s = houseDays.get(r.scout) || new Set<string>();
    s.add(`${r.date}|${r.greenhouse}`);
    houseDays.set(r.scout, s);
  }
  const counts = [...houseDays.entries()].map(([scout, s]) => ({ scout, n: s.size }));
  const m = median(counts.map((c) => c.n));
  const load = counts
    .sort((a, b) => b.n - a.n || a.scout.localeCompare(b.scout))
    .map(({ scout, n }) => ({
      scout,
      houseDays: n,
      diff: Math.round((n - m) * 10) / 10,
      flag: m > 0 && Math.abs(n - m) > LOAD_TOLERANCE * m ? (n > m ? ("high" as const) : ("low" as const)) : null,
    }));
  const here = new Set(rows.map((r) => `${r.scout}|${r.date}`));
  const clash = new Map<string, Set<string>>();
  for (const e of elsewhere) {
    const k = `${e.scout}|${e.date}`;
    if (here.has(k) && e.farm && e.farm !== farm) {
      const s = clash.get(k) || new Set<string>();
      s.add(e.farm);
      clash.set(k, s);
    }
  }
  const conflicts = [...clash.entries()]
    .map(([k, fs]) => {
      const [scout, date] = k.split("|");
      return { scout, date, farms: [...new Set([...(farm ? [farm] : []), ...fs])].sort() };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.scout.localeCompare(b.scout));
  const onLeave = rows
    .filter((r) => leaves[r.scout]?.[r.date] === "on_leave")
    .map((r) => ({ scout: r.scout, date: r.date, greenhouse: r.greenhouse }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.scout.localeCompare(b.scout) || a.greenhouse.localeCompare(b.greenhouse));
  return { unplanned, median: m, load, conflicts, onLeave };
}
