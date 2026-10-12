/**
 * Crop-protection finances endpoint (ported from mona).
 * Backend: upande_scp.serverscripts.reports.finances.chemical_cost_by_target
 * Gated to SCP General Manager / System Manager server-side.
 */
import { call } from "./frappe";

export type ProductKind = "chemical" | "foliar";

/**
 * One greenhouse x target figure, carrying its own provenance.
 *
 * `attributed` is pinned down by the product's own targets. `split` was divided
 * equally across the plan's targets because the product's targets do not match
 * them — a convention, not a measurement. The two always sum to `value`.
 */
export interface CostCell {
  value: number;
  attributed: number;
  split: number;
  /** item codes whose targets did not match the plan, behind `split` */
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
  /** column order: pests and diseases, then "Nutrition" for foliars */
  targets: string[];
  rows: FinanceGreenhouseRow[];
  target_totals: Record<string, number>;
  total: number;
}

/** What treating one pest or disease cost over the period, across farms. */
export interface TargetCost {
  target: string;
  kind: "pest" | "disease";
  value: number;
  attributed: number;
  split: number;
  /** fraction (0..1) of all pest/disease spend */
  share: number;
  /** distinct greenhouses it was spent in */
  houses: number;
}

/** Spend with no work order targets — so no greenhouse and no target. */
export interface UnattributedEntry {
  farm: string;
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

/** A consumed line valued at zero — counted as 0, listed so it is not missed. */
export interface NoValuationLine {
  stock_entry: string;
  posting_date: string;
  item_code: string;
  item_name: string;
  kind: ProductKind;
  qty: number;
  uom: string | null;
  greenhouse: string | null;
  farm: string;
}

export interface ChemicalCostReport {
  as_of: string;
  currency: string;
  /** item_code -> item_name, so codes can be shown as readable names */
  item_names: Record<string, string>;
  farms: FinanceFarm[];
  cost_per_target: TargetCost[];
  unattributed: UnattributedEntry[];
  untargeted_items: UntargetedItem[];
  no_valuation: NoValuationLine[];
  totals_by_kind: Record<ProductKind, number>;
  grand_total: number;
}

export async function fetchChemicalCostByTarget(
  fromDate: string,
  toDate: string,
  opts: { farm?: string; crop?: string } = {},
): Promise<ChemicalCostReport> {
  return call<ChemicalCostReport>(
    "upande_scp.serverscripts.reports.finances.chemical_cost_by_target",
    {
      from_date: fromDate,
      to_date: toDate,
      ...(opts.farm ? { farm: opts.farm } : {}),
      ...(opts.crop ? { crop: opts.crop } : {}),
    },
  );
}

// ── Budget view (B7) ─────────────────────────────────────────────────────

export interface BudgetFigures {
  /** GL Entry on the farm's cost-centre subtree; null when the farm has no cost centre. */
  actual: number | null;
  /** Submitted ERPNext Budgets (annual amounts) for the fiscal years in the period. */
  budget: number;
  /** SCP-drafted Budgets awaiting the GM's submit. */
  draft_budget: number;
  /** Value of procurement cycles approved for periods overlapping this one. */
  approved: number;
  /** The target report's figure: product valued as it leaves the store for use. */
  stock_based: number;
  /** stock_based minus actual — mostly product moved into a CSU but not yet sprayed. */
  reconciling: number | null;
}

export interface BudgetFarm extends BudgetFigures {
  farm: string;
  company: string | null;
  cost_center: string | null;
  mapped: boolean;
  kinds: Record<ProductKind, BudgetFigures>;
}

export interface OutsideSpend {
  company: string;
  cost_center: string;
  kind: ProductKind;
  amount: number;
}

export interface BudgetReport {
  as_of: string;
  currency: string;
  from_date: string;
  to_date: string;
  fiscal_years: Record<string, string[]>;
  farms: BudgetFarm[];
  /** Same accounts, booked on cost centres under no mapped farm (e.g. Main - KR). */
  outside: OutsideSpend[];
  outside_total: number;
  stock_unassigned: number;
  totals: Omit<BudgetFigures, "actual" | "reconciling"> & { actual: number; reconciling: number };
  notes: string[];
}

export async function fetchBudgetVsActual(
  fromDate: string,
  toDate: string,
  opts: { crop?: string } = {},
): Promise<BudgetReport> {
  return call<BudgetReport>(
    "upande_scp.serverscripts.reports.finance_budget.budget_vs_actual",
    {
      from_date: fromDate,
      to_date: toDate,
      ...(opts.crop ? { crop: opts.crop } : {}),
    },
  );
}
