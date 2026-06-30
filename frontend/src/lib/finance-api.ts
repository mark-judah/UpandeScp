/**
 * Chemical-cost finances endpoint.
 * Backend: upande_scp.serverscripts.finances.chemical_cost_by_target
 * Gated to General Manager / System Manager server-side.
 */
import { call } from "./frappe";

export interface FinanceGreenhouseRow {
  greenhouse: string;
  /** target name -> cost */
  costs: Record<string, number>;
  total: number;
}

export interface FinanceFarm {
  farm: string;
  /** pest/disease column order */
  targets: string[];
  rows: FinanceGreenhouseRow[];
  target_totals: Record<string, number>;
  total: number;
}

export interface ChemicalCostReport {
  as_of: string;
  currency: string;
  farms: FinanceFarm[];
  grand_total: number;
}

export async function fetchChemicalCostByTarget(
  fromDate: string,
  toDate: string,
  farm?: string,
): Promise<ChemicalCostReport> {
  return call<ChemicalCostReport>(
    "upande_scp.serverscripts.finances.chemical_cost_by_target",
    { from_date: fromDate, to_date: toDate, ...(farm ? { farm } : {}) },
  );
}
