/**
 * Client for farm-to-farm chemical loaning
 * (``upande_scp.serverscripts.spray_plan_creator.loaning``).
 */
import { call } from "./frappe";

const NS = "upande_scp.serverscripts.spray_plan_creator.loaning";

export interface LoanableChemical {
  item_code: string;
  item_name: string;
  uom: string;
  on_hand: number;
  baseline_qty: number | null;
  depleted: boolean;
}

export interface LoanSource {
  source_farm: string;
  source_warehouse: string | null;
  lendable: number;
  on_hand: number;
}

export interface RequestSource {
  source_farm: string;
  source_warehouse: string | null;
  qty: number;
  approved: boolean;
  approved_by: string | null;
  approved_on: string | null;
  stock_entry: string | null;
}

export type RequestState =
  | "Draft"
  | "Pending Approval"
  | "Approved"
  | "Fulfilled"
  | "Rejected"
  | "Expired";

export interface LoanRequest {
  name: string;
  requesting_farm: string;
  requesting_warehouse: string | null;
  item_code: string;
  item_name: string;
  uom: string;
  requested_qty: number;
  workflow_state: RequestState;
  reason: string | null;
  rejected_reason: string | null;
  expires_on: string | null;
  creation: string;
  sources: RequestSource[];
}

export function fetchMyFarms() {
  return call<{ farms: string[]; enabled: boolean }>(`${NS}.my_farms`);
}

export function fetchLoanableChemicals(farm: string) {
  return call<LoanableChemical[]>(`${NS}.get_loanable_chemicals`, { farm });
}

export function fetchSourcesFor(farm: string, itemCode: string) {
  return call<LoanSource[]>(`${NS}.get_sources_for`, { farm, item_code: itemCode });
}

export function listRequests(box: "mine" | "incoming") {
  return call<LoanRequest[]>(`${NS}.list_requests`, { box });
}

export function createLoanRequest(payload: {
  requesting_farm: string;
  item_code: string;
  uom: string;
  requested_qty: number;
  sources: { source_farm: string; qty: number }[];
  reason?: string;
}) {
  return call<{ name: string }>(`${NS}.create_request`, {
    payload: JSON.stringify(payload),
  });
}

export function approveSource(request: string, sourceFarm: string) {
  return call<LoanRequest>(`${NS}.approve_source`, { request, source_farm: sourceFarm });
}

export function rejectRequest(request: string, reason?: string) {
  return call<LoanRequest>(`${NS}.reject_request`, { request, reason });
}

export function bulkRestock(farm?: string) {
  return call<{ farms: number; baselines_set: number }>(`${NS}.bulk_restock`, { farm });
}
