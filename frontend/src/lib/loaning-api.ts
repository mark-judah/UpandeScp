/**
 * SUPERSEDED (web): everything above the "v2" banner belonged to the original
 * flow, where one chemical was split across up to five lender farms. The
 * ChemicalLoaning page now uses the directed multi-item calls at the bottom of
 * this file, and none of the legacy wrappers has a caller in the web app.
 *
 * They are kept rather than deleted because the SERVER endpoints they wrap
 * (loaning.create_request / approve_source / …) may still be called by the React
 * Native app, which lives in another repo — so removing the endpoints is not a
 * decision to take from here. Delete these wrappers once that is confirmed.
 *
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
}

export interface LoanCartItem {
  item_code: string;
  uom: string;
  requested_qty: number;
  sources: { source_farm: string; qty: number }[];
}

export interface CreditorRow {
  creditor_farm: string;
  item_code: string;
  item_name: string;
  uom: string;
  qty: number;
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

export function createRequests(payload: {
  requesting_farm: string;
  reason?: string;
  items: LoanCartItem[];
}) {
  return call<{ names: string[]; failed: { item_code: string; error: string }[] }>(
    `${NS}.create_requests`,
    { payload: JSON.stringify(payload) },
  );
}

export function getCreditors(farm: string) {
  return call<CreditorRow[]>(`${NS}.get_creditors`, { farm });
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

/* =============================================================
 * v2 — directed, multi-item loaning
 *
 * A request is addressed to ONE lender farm and carries several chemicals or
 * foliars, each decided on its own. Replaces the old flow where a requester
 * split one chemical across up to five lenders (which meant every farm could see
 * the request).
 *
 * Named `*DirectedLoan*` rather than reusing the legacy names: the old page is
 * still on the original client, and shadowing the exports would make it unclear
 * which flow a call site belongs to.
 * ============================================================= */

const V2 = "upande_scp.serverscripts.spray_plan_creator.loaning_v2";

export type LoanItemStatus = "Pending" | "Approved" | "Rejected";
export type ProductKind = "chemical" | "foliar";

export interface LoanRequestItem {
  item_code: string;
  item_name?: string;
  uom?: string;
  requested_qty: number;
  status: LoanItemStatus;
  approved_qty?: number;
  /** Lender's on-hand when the request was raised — kept so the over-half
   *  judgement stays auditable after stock moves on. */
  lender_on_hand?: number;
  stock_entry?: string | null;
}

export interface LoanRequestV2 {
  name: string;
  requesting_farm: string;
  requesting_warehouse?: string;
  lender_farm: string;
  lender_warehouse?: string;
  workflow_state: string;
  reason?: string;
  expires_on?: string | null;
  rejected_reason?: string | null;
  creation: string;
  owner: string;
  items: LoanRequestItem[];
}

export interface LenderStockRow {
  on_hand: number;
  uom: string;
  /** chemical vs foliar — they live in, and move between, different stores. */
  kind: ProductKind;
  store: string | null;
}

export async function listLenderFarms(requestingFarm: string): Promise<string[]> {
  try {
    return (await call<string[]>(`${V2}.list_lender_farms`, {
      requesting_farm: requestingFarm,
    })) || [];
  } catch {
    return [];
  }
}

/** On-hand at the lender for the NAMED items only.
 *
 *  Deliberately not a browse call — a borrower has no business enumerating
 *  another farm's inventory, so the items must be named first. */
export async function fetchLenderStock(
  lenderFarm: string,
  itemCodes: string[],
): Promise<Record<string, LenderStockRow>> {
  if (!lenderFarm || !itemCodes.length) return {};
  try {
    return (
      (await call<Record<string, LenderStockRow>>(`${V2}.get_lender_stock`, {
        lender_farm: lenderFarm,
        item_codes: JSON.stringify(itemCodes),
      })) || {}
    );
  } catch {
    return {};
  }
}

export async function listDirectedLoans(
  box: "outgoing" | "incoming",
): Promise<LoanRequestV2[]> {
  try {
    return (await call<LoanRequestV2[]>(`${V2}.list_requests_v2`, { box })) || [];
  } catch {
    return [];
  }
}

export async function createDirectedLoan(payload: {
  requesting_farm: string;
  lender_farm: string;
  items: Array<{ item_code: string; requested_qty: number }>;
  reason?: string;
}): Promise<{ name: string; over_half: string[] }> {
  return await call<{ name: string; over_half: string[] }>(
    `${V2}.create_loan_request`,
    { payload: JSON.stringify(payload) },
  );
}

export async function decideLoanItems(
  request: string,
  decisions: Array<{
    item_code: string;
    status: "Approved" | "Rejected";
    approved_qty?: number;
  }>,
): Promise<{ name: string; state: string; stock_entry: string | null }> {
  return await call(`${V2}.decide_items`, {
    request,
    decisions: JSON.stringify(decisions),
  });
}

export async function rejectLoanRequest(
  request: string,
  reason?: string,
): Promise<{ name: string; state: string }> {
  return await call(`${V2}.reject_whole_request`, { request, reason });
}

/** True when a line takes more than half what the lender had at request time.
 *  Informational — it never blocked the request. */
export function isOverHalf(item: LoanRequestItem): boolean {
  const onHand = Number(item.lender_on_hand ?? 0);
  return onHand > 0 && Number(item.requested_qty) > onHand * 0.5;
}

/** One-line summary of where a request stands, from its item lines rather than
 *  the workflow field — the lines are the source of truth once decisions start. */
export function summariseLoan(req: LoanRequestV2): string {
  const items = req.items || [];
  if (!items.length) return req.workflow_state || "—";
  const n = items.length;
  const ok = items.filter((i) => i.status === "Approved").length;
  const no = items.filter((i) => i.status === "Rejected").length;
  const pending = n - ok - no;
  if (pending === n) return `${n} item${n === 1 ? "" : "s"} awaiting decision`;
  if (ok === n) return `all ${n} approved`;
  if (no === n) return `all ${n} declined`;
  const parts: string[] = [];
  if (ok) parts.push(`${ok} approved`);
  if (no) parts.push(`${no} declined`);
  if (pending) parts.push(`${pending} pending`);
  return parts.join(", ");
}
