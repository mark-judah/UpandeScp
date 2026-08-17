/**
 * Client for the chemical procurement cycle
 * (``upande_scp.serverscripts.store.procurement``).
 *
 * Three audiences share this module because they share the documents: a planner
 * states and amends their farm's requirement, the GM consolidates and reduces,
 * and the general store keeper decides who draws on the leftover pool.
 */
import { call } from "./frappe";

const NS = "upande_scp.serverscripts.store.procurement";

export type CycleStatus =
  | "Draft"
  | "Collecting"
  | "Planner Review"
  | "GM Review"
  | "Approved"
  | "Ordered"
  | "Received"
  | "Allocated"
  | "Closed";

export type RequirementStatus =
  | "Draft"
  | "Submitted"
  | "Planner Approved"
  | "Rejected"
  | "Amendment Requested"
  | "Superseded";

export type ReductionMode = "None" | "Absolute" | "Percentage";

export interface Cycle {
  name: string;
  cycle_name: string;
  company: string;
  period_start: string | null;
  period_end: string | null;
  status: CycleStatus;
  general_store: string | null;
  material_request: string | null;
}

export interface CycleLine {
  item_code: string;
  item_name: string;
  uom: string;
  total_requested: number;
  reduction_mode: ReductionMode;
  reduction_value: number;
  approved_qty: number;
  allocation_step: number;
  allocated_total: number;
  remainder: number;
  /** Locked: the figure the GM settled on. Changing it needs an amendment. */
  final_approved: boolean;
}

export interface CycleAllocation {
  item_code: string;
  farm: string;
  uom: string;
  requested_qty: number;
  credit_in: number;
  basis_qty: number;
  allocated_qty: number;
  steps: number;
  credit_out: number;
  target_warehouse: string | null;
  stock_entry: string | null;
  transferred: boolean;
}

export interface CycleDetail extends Cycle {
  notes: string | null;
  lines: CycleLine[];
  allocations: CycleAllocation[];
}

export interface RequirementItem {
  item_code: string;
  item_name?: string;
  uom?: string;
  requested_qty: number;
  suggested_qty?: number;
  kind?: "chemical" | "foliar";
  note?: string | null;
}

export interface Requirement {
  name: string;
  farm: string;
  cycle: string;
  status: RequirementStatus;
  reviewed_by?: string | null;
  reviewed_on?: string | null;
  rejection_reason?: string | null;
  notes?: string | null;
  items: RequirementItem[];
}

export interface AmendmentItem {
  item_code: string;
  item_name?: string;
  current_qty: number;
  proposed_qty: number;
  uom?: string;
  reason?: string | null;
}

export interface Amendment {
  name: string;
  requirement: string;
  farm: string;
  cycle: string;
  status: "Pending" | "Granted" | "Declined";
  reason: string;
  requested_by: string;
  requested_on: string;
  decided_by?: string | null;
  decision_note?: string | null;
  items: AmendmentItem[];
}

export interface AllocationPreviewRow {
  farm: string;
  requested: number;
  credit_in: number;
  basis: number;
  allocated: number;
  steps: number;
  credit_out: number;
}

/** Which split produced the figures. "simple" is the default: shares rounded down,
 *  remainder to the general store. "balanced" adds largest-remainder redistribution
 *  and carry-forward credits, and is the GM's opt-in. */
export type AllocationMode = "simple" | "balanced";

export interface AllocationPreviewLine {
  item_code: string;
  item_name: string;
  uom: string;
  received: number;
  step: number;
  distributed: number;
  remainder: number;
  allocations: AllocationPreviewRow[];
  carried_forward: Record<string, number>;
}

export interface PoolCredit {
  farm: string;
  item_code: string;
  item_name?: string;
  uom?: string;
  credit_qty: number;
  last_cycle?: string | null;
}

export interface PoolStatus {
  store: string | null;
  on_hand: { item_code: string; actual_qty: number; stock_uom: string }[];
  credits: PoolCredit[];
  owed_by_item: Record<string, number>;
  /** Whether those credits are actually applied, or on hold. */
  mode: AllocationMode;
}

export interface PoolRequestItem {
  item_code: string;
  item_name?: string;
  uom?: string;
  requested_qty: number;
  status: "Pending" | "Approved" | "Rejected";
  approved_qty?: number;
  /** What was free in the pool when the request was raised. */
  lender_on_hand?: number;
  stock_entry?: string | null;
}

export interface PoolRequest {
  name: string;
  requesting_farm: string;
  lender_warehouse: string;
  workflow_state: string;
  reason?: string | null;
  rejected_reason?: string | null;
  creation: string;
  owner: string;
  items: PoolRequestItem[];
}

// ── cycles ────────────────────────────────────────────────────────────────

export async function listCycles(status?: CycleStatus): Promise<Cycle[]> {
  try {
    return (await call<Cycle[]>(`${NS}.list_cycles`, status ? { status } : {})) || [];
  } catch {
    return [];
  }
}

export async function companiesForCycle(): Promise<
  { company: string; general_store: string }[]
> {
  try {
    return (
      (await call<{ company: string; general_store: string }[]>(
        `${NS}.companies_for_cycle`,
      )) || []
    );
  } catch {
    return [];
  }
}

export function createCycle(payload: {
  cycle_name: string;
  company: string;
  period_start: string;
  period_end: string;
}): Promise<string> {
  return call<string>(`${NS}.create_cycle`, payload);
}

export function getCycle(cycle: string): Promise<CycleDetail> {
  return call<CycleDetail>(`${NS}.get_cycle`, { cycle });
}

export function consolidateCycle(cycle: string): Promise<CycleDetail> {
  return call<CycleDetail>(`${NS}.consolidate`, { cycle });
}

export function setReduction(
  cycle: string,
  itemCode: string,
  mode: ReductionMode,
  value: number,
  reason?: string,
): Promise<CycleDetail> {
  return call<CycleDetail>(`${NS}.set_reduction`, {
    cycle,
    item_code: itemCode,
    mode,
    value,
    reason,
  });
}

export function finaliseLine(cycle: string, itemCode: string): Promise<CycleDetail> {
  return call<CycleDetail>(`${NS}.finalise_line`, { cycle, item_code: itemCode });
}

export function createMaterialRequest(
  cycle: string,
  scheduleDate?: string,
): Promise<string> {
  return call<string>(`${NS}.create_material_request`, {
    cycle,
    schedule_date: scheduleDate,
  });
}

// ── requirements ──────────────────────────────────────────────────────────

export function myRequirement(cycle: string, farm: string): Promise<Requirement> {
  return call<Requirement>(`${NS}.my_requirement`, { cycle, farm });
}

export function saveRequirement(
  name: string,
  items: { item_code: string; requested_qty: number; uom?: string; note?: string }[],
  notes?: string,
): Promise<Requirement> {
  return call<Requirement>(`${NS}.save_requirement`, {
    name,
    items: JSON.stringify(items),
    notes,
  });
}

export function submitRequirement(name: string): Promise<Requirement> {
  return call<Requirement>(`${NS}.submit_requirement`, { name });
}

export function reviewRequirement(
  name: string,
  decision: "approve" | "reject",
  reason?: string,
): Promise<Requirement> {
  return call<Requirement>(`${NS}.review_requirement`, { name, decision, reason });
}

export async function requirementsFor(cycle: string): Promise<
  (Requirement & { total_lines: number })[]
> {
  try {
    return (
      (await call<(Requirement & { total_lines: number })[]>(
        `${NS}.requirements_for`,
        { cycle },
      )) || []
    );
  } catch {
    return [];
  }
}

// ── amendments ────────────────────────────────────────────────────────────

export function requestAmendment(
  requirement: string,
  items: { item_code: string; proposed_qty: number; uom?: string; reason?: string }[],
  reason: string,
): Promise<string> {
  return call<string>(`${NS}.request_amendment`, {
    requirement,
    items: JSON.stringify(items),
    reason,
  });
}

export function decideAmendment(
  name: string,
  decision: "grant" | "decline",
  note?: string,
): Promise<{ name: string; status: string; requirement: string }> {
  return call(`${NS}.decide_amendment`, { name, decision, note });
}

export async function listAmendments(
  cycle?: string,
  status?: string,
): Promise<Amendment[]> {
  try {
    return (await call<Amendment[]>(`${NS}.list_amendments`, { cycle, status })) || [];
  } catch {
    return [];
  }
}

// ── allocation ────────────────────────────────────────────────────────────

export function previewAllocation(
  cycle: string,
  received?: Record<string, number>,
): Promise<{ cycle: string; mode: AllocationMode; lines: AllocationPreviewLine[] }> {
  return call(`${NS}.preview_allocation`, {
    cycle,
    received: received ? JSON.stringify(received) : undefined,
  });
}

export function publishAllocation(
  cycle: string,
  received?: Record<string, number>,
): Promise<CycleDetail> {
  return call<CycleDetail>(`${NS}.publish_allocation`, {
    cycle,
    received: received ? JSON.stringify(received) : undefined,
  });
}

export function transferAllocation(cycle: string): Promise<{
  cycle: string;
  entries: { farm: string; stock_entry: string; lines: number }[];
  skipped: { farm: string; item_code: string; why: string }[];
}> {
  return call(`${NS}.transfer_allocation`, { cycle });
}

// ── the pool ──────────────────────────────────────────────────────────────

export async function poolStatus(company?: string): Promise<PoolStatus> {
  try {
    return await call<PoolStatus>(`${NS}.pool_status`, { company });
  } catch {
    return { store: null, on_hand: [], credits: [], owed_by_item: {}, mode: "simple" };
  }
}

export function poolAvailability(
  company: string | undefined,
  itemCodes: string[],
): Promise<{
  store: string | null;
  items: Record<
    string,
    { on_hand: number; reserved: number; available: number; uom: string }
  >;
}> {
  return call(`${NS}.pool_availability`, {
    company,
    item_codes: JSON.stringify(itemCodes),
  });
}

export function requestFromPool(
  requestingFarm: string,
  items: { item_code: string; requested_qty: number; uom?: string }[],
  reason?: string,
): Promise<{ name: string; over_available: string[]; credits: Record<string, number> }> {
  return call(`${NS}.request_from_pool`, {
    requesting_farm: requestingFarm,
    items: JSON.stringify(items),
    reason,
  });
}

export async function listPoolRequests(
  box: "incoming" | "outgoing",
): Promise<PoolRequest[]> {
  try {
    return (await call<PoolRequest[]>(`${NS}.list_pool_requests`, { box })) || [];
  } catch {
    return [];
  }
}

export function decidePoolRequest(
  request: string,
  decisions: {
    item_code: string;
    status: "Approved" | "Rejected";
    approved_qty?: number;
  }[],
  reason?: string,
): Promise<{ name: string; state: string }> {
  return call(`${NS}.decide_pool_request`, {
    request,
    decisions: JSON.stringify(decisions),
    reason,
  });
}

export function consumptionVsAllocation(cycle: string): Promise<
  { farm: string; item_code: string; allocated: number; consumed: number; over: number }[]
> {
  return call(`${NS}.consumption_vs_allocation`, { cycle });
}

// ── presentation helpers (pure, unit-tested) ──────────────────────────────

/** What a reduction resolves to. Mirrors the server so the GM sees the number
 *  before committing to it — the server stays the authority. */
export function resolveReduction(
  total: number,
  mode: ReductionMode,
  value: number,
): number {
  if (mode === "Absolute") return Math.max(0, Math.min(value || 0, total));
  if (mode === "Percentage") {
    const pct = Math.min(Math.max(value || 0, 0), 100);
    return Math.round(total * (1 - pct / 100) * 1e9) / 1e9;
  }
  return total;
}

/** A credit is money owed in kind; show the direction, not just the number. */
export function describeCredit(qty: number, uom?: string): string {
  const unit = uom ? ` ${uom}` : "";
  if (Math.abs(qty) < 1e-9) return "settled";
  return qty > 0
    ? `owed ${qty.toFixed(3).replace(/\.?0+$/, "")}${unit}`
    : `paid ahead ${Math.abs(qty).toFixed(3).replace(/\.?0+$/, "")}${unit}`;
}

/** Whether a requirement can still be edited in place, or needs an amendment. */
export function isEditable(status: RequirementStatus): boolean {
  return status === "Draft";
}

/** One line of the story a planner needs: where their requirement stands. */
export function describeRequirement(req: Requirement): string {
  switch (req.status) {
    case "Draft":
      return req.items.length
        ? `${req.items.length} chemical${req.items.length === 1 ? "" : "s"} — not submitted yet`
        : "nothing added yet";
    case "Submitted":
      return "waiting for review";
    case "Planner Approved":
      return "approved — counted in the cycle total";
    case "Rejected":
      return req.rejection_reason
        ? `rejected: ${req.rejection_reason}`
        : "rejected — request an amendment to change it";
    case "Amendment Requested":
      return "amendment awaiting a decision";
    default:
      return req.status;
  }
}
