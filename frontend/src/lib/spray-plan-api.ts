/**
 * API helpers for the Spray Plan Approval page — direct mirrors of the
 * legacy `www/spray_plan_approval/spray_plan_approval.js` API surface.
 *
 * The legacy page used an alternate approval flow that creates draft
 * Stock Entries (Material Transfer for Manufacture) and emits QR labels
 * per chemical, distinct from the simpler docstatus-flip endpoint the
 * earlier React `Approvals` page was calling. This module exposes the
 * legacy endpoints so the React rewrite reaches feature parity.
 */

import { call } from "./frappe";

const ENDPOINTS = {
  GET_WO: "upande_scp.serverscripts.spray_plan_approval.get_pending_work_orders",
  GET_FARMS:
    "upande_scp.serverscripts.spray_plan_approval.get_farms_and_greenhouses",
  APPROVE:
    "upande_scp.serverscripts.spray_plan_approval.approve_single_work_order",
  STOP: "upande_scp.serverscripts.spray_plan_approval.stop_single_work_order",
} as const;

export interface RequiredItem {
  parent?: string;
  item_code: string;
  item_name?: string;
  required_qty?: number;
  stock_uom?: string;
}

export interface PendingWorkOrder {
  name: string;
  custom_greenhouse?: string;
  creation?: string;
  custom_scheduled_application_time?: string;
  custom_spray_type?: string;
  custom_scope?: string;
  custom_scope_details?: string;
  custom_area?: number;
  custom_water_volume?: number;
  custom_water_ph?: number;
  custom_water_hardness?: number;
  custom_kit?: string;
  wip_warehouse?: string;
  /** Newline-separated string. Parse with parseTargets(). */
  custom_targets?: string;
  required_items: RequiredItem[];
  is_forwarded: boolean;
  farm?: string;
}

export interface PendingWorkOrdersResponse {
  work_orders: PendingWorkOrder[];
  /** Distinct farms across the returned WOs — useful for the filter cascade. */
  farms?: string[];
}

export interface FarmsAndGreenhouses {
  farms: string[];
  greenhouses_by_farm: Record<string, string[]>;
}

export interface QrLabel {
  chemical: string;
  item_code: string;
  qty: string;
  uom: string;
  src_wh: string;
  tgt_wh: string;
  farm: string;
  greenhouse: string;
  wo: string;
  se: string;
  png_base64: string;
}

export interface ApproveResult {
  wo: string;
  status: "approved" | "already_forwarded" | "skipped" | "error";
  se?: string;
  warehouse?: string;
  qr_labels?: QrLabel[];
  message?: string;
}

export interface StopResult {
  wo: string;
  status: "stopped" | "error";
  message?: string;
}

export async function fetchPendingWorkOrders(args: {
  from_date?: string | null;
  to_date?: string | null;
  farm?: string | null;
  greenhouse?: string | null;
}): Promise<PendingWorkOrdersResponse> {
  const r = await call<PendingWorkOrdersResponse>(ENDPOINTS.GET_WO, args);
  return r || { work_orders: [] };
}

export async function fetchFarmsAndGreenhouses(): Promise<FarmsAndGreenhouses> {
  const r = await call<FarmsAndGreenhouses>(ENDPOINTS.GET_FARMS, {});
  return r || { farms: [], greenhouses_by_farm: {} };
}

export async function approveWorkOrder(wo_name: string): Promise<ApproveResult> {
  const r = await call<ApproveResult>(ENDPOINTS.APPROVE, { wo_name });
  return r;
}

export async function stopWorkOrder(wo_name: string): Promise<StopResult> {
  const r = await call<StopResult>(ENDPOINTS.STOP, { wo_name });
  return r;
}

/** Newline-separated targets string → cleaned array. */
export function parseTargets(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Format a stock quantity the same way the legacy page does. */
export function formatQty(val: any): string {
  if (val === null || val === undefined) return "—";
  const n = parseFloat(val);
  if (!Number.isFinite(n)) return String(val);
  if (n % 1 === 0) return String(n);
  return n.toFixed(3).replace(/\.?0+$/, "");
}
