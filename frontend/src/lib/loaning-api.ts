/**
 * Client for farm-to-farm loaning
 * (``upande_scp.serverscripts.spray_plan_creator.loaning`` + ``loaning_v2``).
 *
 * Only ``fetchMyFarms`` survives from the original single-chemical/many-lenders
 * flow — everything else is the directed multi-item API below. The legacy
 * wrappers and their types are gone rather than deprecated: their server
 * endpoints were deleted too, and nothing under the mobile app's namespace ever
 * called them.
 */
import { call } from "./frappe";

const NS = "upande_scp.serverscripts.spray_plan_creator.loaning";

export function fetchMyFarms() {
  return call<{ farms: string[]; enabled: boolean }>(`${NS}.my_farms`);
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
