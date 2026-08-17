/**
 * Client for spray-plan postponement
 * (``upande_scp.serverscripts.spray_plan_creator.postponement``).
 *
 * A supervisor declares that a plan will not go out; the plan's approver decides. The
 * plan keeps its original date until the decision, so a pending request never quietly
 * changes what the store and the sprayers are working to.
 */
import { call } from "./frappe";

const NS = "upande_scp.serverscripts.spray_plan_creator.postponement";

export type PostponementStatus = "Pending" | "Approved" | "Rejected" | "Withdrawn";

export interface Postponement {
  name: string;
  work_order: string;
  farm: string | null;
  greenhouse: string | null;
  state_at_declaration: string | null;
  from_datetime: string | null;
  to_datetime: string | null;
  status: PostponementStatus;
  reason: string;
  declared_by: string;
  declared_on: string | null;
  decided_by: string | null;
  decided_on: string | null;
  decision_note: string | null;
}

export interface PostponablePlan {
  work_order: string;
  state: string;
  greenhouse: string | null;
  farm: string | null;
  scheduled: string | null;
  /** The plan's own date at the cutoff time — not the cutoff time today. */
  deadline: string | null;
  past_cutoff: boolean;
  /** False once even the grace window has closed. */
  can_postpone: boolean;
  request_pending: boolean;
}

export interface PostponementSettings {
  cutoff_time: string;
  max_days: number;
  grace_minutes: number;
  postponable_states: string[];
}

export async function fetchPostponementSettings(): Promise<PostponementSettings> {
  try {
    return await call<PostponementSettings>(`${NS}.postponement_settings`);
  } catch {
    return {
      cutoff_time: "10:00:00",
      max_days: 7,
      grace_minutes: 0,
      postponable_states: [],
    };
  }
}

export async function fetchPostponablePlans(
  onDate?: string,
): Promise<PostponablePlan[]> {
  try {
    return (
      (await call<PostponablePlan[]>(`${NS}.postponable_plans`, {
        on_date: onDate,
      })) || []
    );
  } catch {
    return [];
  }
}

export async function listPostponements(
  status?: PostponementStatus,
): Promise<Postponement[]> {
  try {
    return (
      (await call<Postponement[]>(`${NS}.list_postponements`, { status })) || []
    );
  } catch {
    return [];
  }
}

export function declarePostponement(
  workOrder: string,
  toDate: string,
  reason: string,
): Promise<Postponement> {
  return call<Postponement>(`${NS}.declare`, {
    work_order: workOrder,
    to_date: toDate,
    reason,
  });
}

export function decidePostponement(
  name: string,
  decision: "approve" | "reject",
  note?: string,
): Promise<Postponement> {
  return call<Postponement>(`${NS}.decide`, { name, decision, note });
}

export function withdrawPostponement(
  name: string,
  note?: string,
): Promise<Postponement> {
  return call<Postponement>(`${NS}.withdraw`, { name, note });
}

export async function postponementHistory(
  workOrder: string,
): Promise<Postponement[]> {
  try {
    return (
      (await call<Postponement[]>(`${NS}.history_for`, {
        work_order: workOrder,
      })) || []
    );
  } catch {
    return [];
  }
}

// ── presentation helpers (pure, unit-tested) ──────────────────────────────

/** `"10:00:00"` → `"10:00"`. The seconds are noise on a deadline. */
export function shortTime(time: string | null | undefined): string {
  if (!time) return "";
  const [h, m] = String(time).split(":");
  return h && m ? `${h}:${m}` : String(time);
}

/**
 * How a plan stands against its deadline, in the words a supervisor needs.
 *
 * Three states, not two: a plan can be past its cutoff but still inside the grace
 * window, which is the case worth spelling out — the spray is off, but the
 * postponement can still be recorded properly instead of the plan being left to rot.
 */
export function describeDeadline(plan: PostponablePlan): {
  tone: "ok" | "warn" | "gone";
  text: string;
} {
  if (!plan.deadline) {
    return { tone: "ok", text: "no scheduled date" };
  }
  if (!plan.past_cutoff) {
    return { tone: "ok", text: `can be moved until ${plan.deadline}` };
  }
  if (plan.can_postpone) {
    return {
      tone: "warn",
      text: "past its cutoff — the spray is off, but it can still be postponed",
    };
  }
  return {
    tone: "gone",
    text: "past its cutoff and past grace — only the General Manager can move it now",
  };
}

/** The furthest date a plan may be pushed to, as a `yyyy-mm-dd` string. */
export function latestAllowed(
  scheduled: string | null,
  maxDays: number,
): string {
  const base = scheduled ? new Date(scheduled) : new Date();
  if (Number.isNaN(base.getTime())) return "";
  base.setDate(base.getDate() + Math.max(0, maxDays));
  return base.toISOString().slice(0, 10);
}

/** One line summarising a decided request, for a history list. */
export function summarisePostponement(p: Postponement): string {
  const move =
    p.from_datetime && p.to_datetime
      ? `${p.from_datetime.slice(0, 16)} → ${p.to_datetime.slice(0, 16)}`
      : "";
  switch (p.status) {
    case "Pending":
      return `awaiting a decision · ${move}`;
    case "Approved":
      return `moved · ${move}`;
    case "Rejected":
      return `refused · stayed on ${p.from_datetime?.slice(0, 16) ?? "its date"}`;
    case "Withdrawn":
      return `withdrawn by ${p.declared_by}`;
    default:
      return p.status;
  }
}
