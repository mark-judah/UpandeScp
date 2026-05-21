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

export interface ChemicalOverview {
  items: ChemicalItemRow[];
  warehouses: ChemicalWarehouseRow[];
  matrix: ChemicalMatrixCell[];
  as_of: string;
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
  scanned: { employee: string; employee_name: string; biometric_id: string };
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

/** The existing Material-Issue biometric flow's first step — server
 *  script ``verify_employee`` reads the latest Biometric Logs row from
 *  the last minute. Used here just as a UX prompt before we call
 *  ``submit_with_biometric``, so the operator gets immediate feedback
 *  on whether the scan was picked up. */
export async function verifyEmployeeScan(): Promise<{
  employee?: string;
  employee_name?: string;
  biometric_id?: string;
  error?: string;
}> {
  const r = await call("verify_employee");
  return unwrap(r);
}
