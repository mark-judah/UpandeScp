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
    "upande_scp.serverscripts.store_keeper_api.chemical_stock_overview",
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
    "upande_scp.serverscripts.store_keeper_api.farm_store_levels",
  );
  return unwrap<FarmStoreLevels>(r);
}

export async function fetchDraftTransfers(opts: {
  farm?: string;
  from_date?: string;
  to_date?: string;
} = {}): Promise<DraftTransfersResp> {
  const r = await call(
    "upande_scp.serverscripts.store_keeper_api.list_draft_transfers",
    opts,
  );
  return unwrap<DraftTransfersResp>(r);
}

export async function submitWithBiometric(
  names: string[],
): Promise<BiometricSubmitResp> {
  const r = await call(
    "upande_scp.serverscripts.store_keeper_api.submit_with_biometric",
    { names: JSON.stringify(names) },
  );
  return unwrap<BiometricSubmitResp>(r);
}

export async function submitWithoutBiometric(
  names: string[],
): Promise<BiometricSubmitResp> {
  const r = await call(
    "upande_scp.serverscripts.store_keeper_api.submit_without_biometric",
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
    "upande_scp.serverscripts.store_keeper_api.verify_employee",
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
    "upande_scp.serverscripts.store_keeper_api.get_transfer_items",
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
    "upande_scp.serverscripts.store_keeper_api.search_employees",
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
    "upande_scp.serverscripts.store_keeper_api.bulk_assign_employee",
    { names: JSON.stringify(names), employee },
  );
  return unwrap<BulkAssignResp>(r);
}
