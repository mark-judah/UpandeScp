/**
 * Crop-protection finances endpoint.
 * Backend: upande_scp.serverscripts.finances.chemical_cost_by_target
 * Gated to General Manager / System Manager server-side.
 */
import { call } from "./frappe";

export type ProductKind = "chemical" | "foliar";

/**
 * One greenhouse x target figure, carrying its own provenance.
 *
 * `attributed` is pinned down by the product's own targets. `split` was divided
 * equally across the plan's targets because the product records none — a
 * convention, not a measurement. The two always sum to `value`.
 */
export interface CostCell {
  value: number;
  attributed: number;
  split: number;
  /** item codes with no targets recorded that contributed to `split` */
  split_items: string[];
}

export interface FinanceGreenhouseRow {
  greenhouse: string;
  kind: ProductKind;
  /** target name -> cell */
  costs: Record<string, CostCell>;
  total: number;
}

export interface FinanceFarm {
  farm: string;
  /** column order: pests, diseases, and "Nutrition" for foliars */
  targets: string[];
  rows: FinanceGreenhouseRow[];
  target_totals: Record<string, number>;
  total: number;
}

/** Spend with no work order — so no greenhouse and no target. */
export interface UnattributedEntry {
  cost_center: string;
  kind: ProductKind;
  value: number;
}

/** A product with no targets recorded; its cost can only ever be split. */
export interface UntargetedItem {
  item_code: string;
  item_name: string;
  kind: ProductKind;
  value: number;
}

export interface ChemicalCostReport {
  as_of: string;
  currency: string;
  /** item_code -> item_name, so codes can be shown as readable names */
  item_names: Record<string, string>;
  farms: FinanceFarm[];
  unattributed: UnattributedEntry[];
  untargeted_items: UntargetedItem[];
  totals_by_kind: Record<ProductKind, number>;
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
