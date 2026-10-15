import type {
  PlannedItem,
  PlannedRow,
  PlannedTotal,
} from "./planned-chemicals";
import { call } from "./frappe";

export interface ChemicalItemRow {
  item_code: string;
  item_name: string;
  group: string;
  uom: string;
  total_qty: number;
}

export interface ChemicalWarehouseRow {
  warehouse: string;
  total_qty: number;
  item_count: number;
}

export interface ChemicalMatrixCell {
  item_code: string;
  warehouse: string;
  qty: number;
}

/** A CSU warehouse, listed regardless of whether it currently holds stock,
 *  so the UI can show the full CSU roster (and disable the empty ones). */
export interface CsuWarehouse {
  warehouse: string;
  farm: string;
}

/** One store-type bucket (chemical or fertilizer) of the overview, already
 *  scoped server-side to the caller's allowed farms. */
export interface StoreBucketStore {
  warehouse: string;
  total_qty: number;
  item_count: number;
}
export interface StoreBucketItem {
  item_code: string;
  total_qty: number;
}
export interface StoreBucket {
  stores: StoreBucketStore[];
  items: StoreBucketItem[];
  matrix: ChemicalMatrixCell[];
  total_qty: number;
}

export interface ChemicalOverview {
  items: ChemicalItemRow[];
  warehouses: ChemicalWarehouseRow[];
  matrix: ChemicalMatrixCell[];
  /** Full CSU roster (all enabled, non-group CSU warehouses) — optional so the
   *  client degrades gracefully against an older backend. */
  csus?: CsuWarehouse[];
  /** The words that define a work-in-progress spray area on this site. Sent by
   *  the server so the client applies the same rule instead of carrying its own
   *  copy of "CSU" — roses call theirs the CSU, an orchard does not. Optional so
   *  the client degrades gracefully against an older backend. */
  wip_keywords?: string[];
  as_of: string;
  /** Per-store-type (chemical / fertilizer) aggregates, farm-scoped
   *  server-side for Store Keepers — optional so the client degrades
   *  gracefully against an older backend. */
  buckets?: {
    chemical: StoreBucket;
    fertilizer: StoreBucket;
  };
  /** Farms the caller is scoped to (null for admins, who see everything). */
  allowed_farms?: string[] | null;
}

export interface TransferEmployee {
  employee: string;
  employee_name: string;
}

export interface TransferRow {
  name: string;
  posting_date: string;
  work_order: string;
  from_warehouse: string;
  to_warehouse: string;
  farm: string;
  total_qty: number;
  item_count: number;
  employees: TransferEmployee[];
  /** Rows naming a batch that has already expired. Recomputed server-side on
   *  every load, never stamped on the document — so fixing the batch clears it
   *  without the page having to remember anything. */
  expired_batches: number;
  /** Shorthand for the above: this draft cannot be sent as it stands. */
  blocked: boolean;
}

export interface DraftTransfersResp {
  rows: TransferRow[];
  farms: string[];
  allow_submit_without_biometric: boolean;
}

export interface BiometricSubmitResult {
  name: string;
  ok: boolean;
  error: string | null;
  /** The entry's docstatus as the database held it after the call. */
  docstatus?: number | null;
}

export interface BiometricSubmitResp {
  ok: number;
  failed: number;
  results: BiometricSubmitResult[];
  method: "biometric" | "manual";
  scanned?: { employee: string; employee_name: string; biometric_id: string };
}

function unwrap<T>(resp: any): T {
  return (resp && resp.message !== undefined ? resp.message : resp) as T;
}

export async function fetchChemicalOverview(): Promise<ChemicalOverview> {
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.chemical_stock_overview",
  );
  return unwrap<ChemicalOverview>(r);
}

export interface StoreLevelStore {
  warehouse: string;
  farm: string;
  label: string;
}
export interface StoreLevelItem {
  item_code: string;
  item_name: string;
  uom: string;
  total: number;
}
export interface StoreLevelBucket {
  stores: StoreLevelStore[];
  items: StoreLevelItem[];
  matrix: ChemicalMatrixCell[];
}
export interface FarmStoreLevels {
  chemical: StoreLevelBucket;
  fertilizer: StoreLevelBucket;
  allowed_farms: string[] | null;
}

export async function fetchFarmStoreLevels(): Promise<FarmStoreLevels> {
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.farm_store_levels",
  );
  return unwrap<FarmStoreLevels>(r);
}

export async function fetchDraftTransfers(opts: {
  farm?: string;
  from_date?: string;
  to_date?: string;
} = {}): Promise<DraftTransfersResp> {
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.list_draft_transfers",
    opts,
  );
  return unwrap<DraftTransfersResp>(r);
}

/** Check the scan once and open a run for this selection, so the submit can
 *  go a few transfers at a time without a fresh thumb for every chunk. */
export async function beginBiometricSubmit(names: string[]): Promise<{
  run: string;
  count: number;
  scanned: { employee: string; employee_name: string; biometric_id: string };
}> {
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.begin_biometric_submit",
    { names: JSON.stringify(names) },
  );
  return unwrap(r);
}

export async function submitWithBiometric(
  names: string[],
  run?: string,
): Promise<BiometricSubmitResp> {
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.submit_with_biometric",
    run ? { names: JSON.stringify(names), run } : { names: JSON.stringify(names) },
  );
  return unwrap<BiometricSubmitResp>(r);
}

/** Lightweight poll target: reflects a GM's biometric-gating toggle without
 *  reloading the page / re-fetching the whole draft list. */
export async function fetchSubmissionGating(): Promise<{
  allow_submit_without_biometric: boolean;
}> {
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.get_submission_gating",
  );
  return unwrap<{ allow_submit_without_biometric: boolean }>(r);
}

export async function submitWithoutBiometric(
  names: string[],
): Promise<BiometricSubmitResp> {
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.submit_without_biometric",
    { names: JSON.stringify(names) },
  );
  return unwrap<BiometricSubmitResp>(r);
}

/** First step of the biometric flow — scp's own ``verify_employee``
 *  endpoint reads the latest Biometric Logs row from the last couple of
 *  minutes. Used here just as a UX prompt before we call
 *  ``submit_with_biometric``, so the operator gets immediate feedback
 *  on whether the scan was picked up. Lives in scp code (not a Desk
 *  Server Script), so the page has no external dependency. */
export async function verifyEmployeeScan(): Promise<{
  employee?: string;
  employee_name?: string;
  biometric_id?: string;
  error?: string;
}> {
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.verify_employee",
  );
  return unwrap(r);
}

export interface TransferItem {
  item_code: string;
  item_name: string;
  qty: number;
  uom: string;
  from_warehouse: string;
  to_warehouse: string;
}

export async function fetchTransferItems(name: string): Promise<TransferItem[]> {
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.get_transfer_items",
    { name },
  );
  const m = unwrap<{ items: TransferItem[] }>(r);
  return m?.items || [];
}

export interface EmployeeHit {
  employee: string;
  employee_name: string;
  designation?: string;
  department?: string;
}

export async function searchEmployees(
  query: string,
  limit = 12,
): Promise<EmployeeHit[]> {
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.search_employees",
    { query, limit },
  );
  return unwrap<EmployeeHit[]>(r) || [];
}

export interface BulkAssignResult {
  name: string;
  ok: boolean;
  error: string | null;
}

export interface BulkAssignResp {
  ok: number;
  failed: number;
  results: BulkAssignResult[];
  employee: { name: string; employee_name: string };
}

export async function bulkAssignEmployee(
  names: string[],
  employee: string,
): Promise<BulkAssignResp> {
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.bulk_assign_employee",
    { names: JSON.stringify(names), employee },
  );
  return unwrap<BulkAssignResp>(r);
}

// ---------------------------------------------------------------------------
// Planned chemicals — plans still waiting on the General Manager.
//
// Read-only by design: there is no submit, no assignment, and no counterpart
// write endpoint. The draft transfer these plans will become does not exist
// until the GM approves, which is exactly why the store could not see them.
// ---------------------------------------------------------------------------
export interface PlannedTransfersResp {
  rows: PlannedRow[];
  farms: string[];
  totals: PlannedTotal[];
  state: string;
}

export async function fetchPlannedTransfers(opts: {
  farm?: string;
  from_date?: string;
  to_date?: string;
} = {}): Promise<PlannedTransfersResp> {
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.list_planned_transfers",
    opts,
  );
  return unwrap<PlannedTransfersResp>(r);
}

export async function fetchPlannedItems(workOrder: string): Promise<PlannedItem[]> {
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.get_planned_items",
    { work_order: workOrder },
  );
  return unwrap<{ items: PlannedItem[] }>(r).items || [];
}

/** One batch as the picker shows it: the code, plus the numbers behind it. */
export interface BatchOption {
  batch_no: string;
  qty: number;
  expiry_date: string | null;
  days_to_expiry: number | null;
  placeholder: boolean;
  /** Came in with no valuation rate: shown, never choosable. */
  zero_valued?: boolean;
  status: "ok" | "expiring" | "expired" | "undated" | "placeholder" | "unvalued";
}

/** What the store rule would take from one batch to cover a row. */
export interface BatchPick {
  batch_no: string;
  qty: number;
  expiry_date: string | null;
}

/** A transfer row, with the batch it has or the batch it should get. */
export interface TransferBatchRow {
  idx: number;
  item_code: string;
  item_name: string;
  qty: number;
  uom: string;
  /** Source store — where the drum is taken from, and which batches are on offer. */
  warehouse: string;
  /** Destination, so this one table can stand in for the transfer's item list. */
  to_warehouse: string;
  batch_no: string;
  needs_batch: boolean;
  /** The batch it carries has no valuation rate, so the transfer cannot go. */
  unvalued?: boolean;
  /** Already carries a batch — shown, never reproposed. */
  settled: boolean;
  /** The batch it carries has expired: the one case where a settled row is
   *  offered the picker again, because nothing can leave the store until it
   *  changes. */
  expired: boolean;
  suggestion: string | null;
  picks: BatchPick[];
  /** How much the available batches cannot cover. Reported, never hidden. */
  short: number;
  options: BatchOption[];
}

export interface TransferBatchSuggestion {
  rows: TransferBatchRow[];
  needs_batch: number;
  unfilled: number;
}

export async function suggestTransferBatches(
  name: string,
): Promise<TransferBatchSuggestion> {
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.suggest_transfer_batches",
    { name },
  );
  return (r ?? { rows: [], needs_batch: 0, unfilled: 0 }) as TransferBatchSuggestion;
}

/** `picks` is row index -> batch. Partial is fine; the server writes all or none.
 *  A batch holding less than its row is used first and the rule covers the rest,
 *  splitting the row one per batch. */
export async function applyTransferBatches(
  name: string,
  picks: Record<number, string>,
): Promise<ApplyBatchesResp> {
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.apply_transfer_batches",
    { name, picks: JSON.stringify(picks) },
  );
  return (r ?? { updated: 0, rows: [], split: [] }) as ApplyBatchesResp;
}

/** Unassign batches on a draft transfer: the given rows, or every batched row when
 *  `idxs` is omitted. A row that was split across batches is merged back into one. */
export async function clearTransferBatches(
  name: string,
  idxs?: number[],
): Promise<{ updated: number }> {
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.clear_transfer_batches",
    { name, idxs: idxs?.length ? JSON.stringify(idxs) : "" },
  );
  return (r ?? { updated: 0 }) as { updated: number };
}

export interface ApplyBatchesResp {
  updated: number;
  rows: string[];
  /** Rows the store covered from more than one batch, now one row per batch. */
  split?: { item_code: string; batches: string[] }[];
}

export interface StockShort {
  item_code: string;
  batch_no: string | null;
  warehouse: string;
  needed: number;
  available_when_its_turn: number;
  short_by: number;
  /** Selected transfers that use the stock first. */
  blocking_transfers: string[];
  /** "unvalued": the named batch has no valuation rate (not a stock shortage). */
  reason?: "unvalued";
}

export interface ZeroValuedBatch {
  item_code: string;
  item_name: string;
  batch_no: string;
  warehouse: string;
  qty: number;
  /** Which rule priced it: the batch's own value, or the item's moving average. */
  method: "batchwise" | "moving_average";
  rate: number;
}

export async function fetchZeroValuedBatches(): Promise<ZeroValuedBatch[]> {
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.get_zero_valued_batches",
    {},
  );
  return ((r as { rows?: ZeroValuedBatch[] } | null)?.rows ?? []) as ZeroValuedBatch[];
}

export function unvaluedMessage(item: string, batch: string, store: string): string {
  return `${item} batch ${batch} in ${store} has no valuation rate (0). Correct its valuation (e.g. a Stock Reconciliation or the purchase receipt rate) before issuing it.`;
}

export interface TransferStockGate {
  ok: boolean;
  shorts: StockShort[];
  /** Rank in plan date / creation / name order - the order select-all adds in. */
  queue?: number;
}

/** Which waiting transfers the store cannot cover. Only the ``selected``
 *  transfers (in click order) hold stock; every other one is judged as if it
 *  were added next. Recomputed on every call; never remember it across edits. */
export async function fetchTransferStockGate(
  names?: string[],
  selected?: string[],
): Promise<Record<string, TransferStockGate>> {
  const args: Record<string, string> = {};
  if (names) args.names = JSON.stringify(names);
  if (selected && selected.length) args.selected = JSON.stringify(selected);
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.get_transfer_stock_gate",
    args,
  );
  return unwrap<Record<string, TransferStockGate>>(r);
}

/** The one-line reason a short transfer cannot be submitted. */
export function stockShortReason(g: TransferStockGate | undefined): string {
  if (!g || g.ok) return "";
  return g.shorts
    .map((s) =>
      s.reason === "unvalued"
        ? unvaluedMessage(s.item_code, s.batch_no ?? "", s.warehouse)
        : `${s.item_code}${s.batch_no ? ` batch ${s.batch_no}` : ""}: needs ${s.needed}, ${s.available_when_its_turn} available, short by ${s.short_by}` +
        (s.blocking_transfers.length ? ` (held by selected ${s.blocking_transfers.join(", ")})` : ""),
    )
    .join("; ");
}
