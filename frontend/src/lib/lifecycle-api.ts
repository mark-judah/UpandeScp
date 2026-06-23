/**
 * Client for the spray-plan lifecycle endpoints
 * (``upande_scp.serverscripts.spray_plan_creator.lifecycle``).
 *
 *  - ``get_lifecycle_summary`` — cheap batch rows for list views / stage tabs.
 *  - ``get_lifecycle``         — full 7-step timeline for one WO (on expand).
 */
import { call } from "./frappe";

/** Stable step keys, in lifecycle order. */
export type LifecycleStepKey =
  | "created"
  | "approved"
  | "chemical_issued"
  | "labels_printed"
  | "labels_scanned"
  | "spraying_started"
  | "completed";

export type StepStatus =
  | "done"
  | "current"
  | "pending"
  | "warning"
  | "skipped";

export interface LifecycleStep {
  key: LifecycleStepKey;
  label: string;
  status: StepStatus;
  actor: string | null;
  timestamp: string | null;
  detail: string | null;
}

export interface Lifecycle {
  work_order: string;
  current_state: string;
  current_step: LifecycleStepKey;
  scheduled: string | null;
  missed: boolean;
  stopped: boolean;
  greenhouse: string | null;
  spray_type: string | null;
  steps: LifecycleStep[];
}

export interface LifecycleSummaryRow {
  name: string;
  current_state: string;
  current_step: LifecycleStepKey;
  stopped: boolean;
  missed: boolean;
  greenhouse: string | null;
  spray_type: string | null;
  scheduled: string | null;
}

const NS = "upande_scp.serverscripts.spray_plan_creator.lifecycle";

export async function fetchLifecycle(workOrder: string): Promise<Lifecycle> {
  return call<Lifecycle>(`${NS}.get_lifecycle`, { work_order: workOrder });
}

export async function fetchLifecycleSummary(args: {
  from_date?: string;
  to_date?: string;
  farm?: string;
  greenhouse?: string;
  states?: string[];
} = {}): Promise<LifecycleSummaryRow[]> {
  const r = await call<LifecycleSummaryRow[]>(`${NS}.get_lifecycle_summary`, {
    ...args,
    states: args.states && args.states.length ? args.states.join(",") : undefined,
  });
  return r || [];
}

/** Ordered states for stage tabs / grouping (matches the backend rank). */
export const LIFECYCLE_STATES = [
  "Pending Submission",
  "Awaiting Approval",
  "Approved",
  "Chemical Issued",
  "Tank Mix Manufactured",
  "Spraying In Progress",
  "Completed",
] as const;
