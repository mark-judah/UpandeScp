/**
 * Crop-protection finances endpoint.
 * Backend: upande_scp.serverscripts.reports.finances.chemical_cost_by_target
 * Gated to General Manager / System Manager server-side.
 *
 * Every figure is the Stock Ledger value of product consumed. Each product's
 * cost on a plan goes to the plan's targets that the product is registered for
 * (split evenly); what no target claims is `unattributed`, never hidden.
 * `targets + unattributed == grand_total` always (see `reconciliation`).
 */
import { call } from "./frappe";

export type ProductKind = "chemical" | "foliar";

/** Why a cost has no pest/disease: it was issued with no plan or no targets. */
export type UnattributedReason = "no_plan";

/** How a product line's cost was assigned to targets, in priority order. */
export type AllocationBasis =
  | "registered"
  | "ai_class"
  | "history"
  | "nutrition"
  | "equal"
  | "unattributed";

export interface BasisShare {
  basis: AllocationBasis;
  value: number;
  /** share of the total spend, 0..1 */
  share: number;
}

export interface TargetProduct {
  item_code: string;
  item_name: string;
  value: number;
}

export interface TargetCost {
  target: string;
  /** "nutrition" is the Crop nutrition & adjuvants line */
  kind: "pest" | "disease" | "nutrition" | null;
  /** this target's spend by allocation basis */
  basis: Partial<Record<AllocationBasis, number>>;
  value: number;
  /** share of the TOTAL spend, 0..1 */
  share: number;
  houses: number;
  products: TargetProduct[];
}

export interface ProductCost {
  item_code: string;
  item_name: string;
  kind: ProductKind;
  value: number;
  attributed: number;
  unattributed: number;
  targets: { target: string; value: number }[];
}

export interface PlaceCost {
  farm: string;
  /** "No plan" for spend with no greenhouse */
  greenhouse: string;
  value: number;
  attributed: number;
  unattributed: number;
}

export interface PeriodCost {
  /** ISO week start (granularity "week") or YYYY-MM ("month") */
  period: string;
  value: number;
  attributed: number;
  unattributed: number;
}

export interface UnattributedEntry {
  farm: string;
  greenhouse: string;
  kind: ProductKind;
  reason: UnattributedReason;
  value: number;
}

export interface FinanceGreenhouseRow {
  greenhouse: string;
  kind: ProductKind;
  /** target name -> attributed cost */
  costs: Record<string, number>;
  total: number;
}

export interface FinanceFarm {
  farm: string;
  targets: string[];
  rows: FinanceGreenhouseRow[];
  target_totals: Record<string, number>;
  total: number;
}

export interface NoValuationLine {
  stock_entry: string;
  posting_date: string;
  item_code: string;
  item_name: string;
  kind: ProductKind;
  qty: number;
  uom: string;
  greenhouse: string | null;
  farm: string;
}

export interface ChemicalCostReport {
  as_of: string;
  currency: string;
  granularity: "week" | "month";
  item_names: Record<string, string>;
  grand_total: number;
  attributed_total: number;
  unattributed_total: number;
  unattributed_share: number;
  totals_by_kind: Record<ProductKind, number>;
  cost_per_target: TargetCost[];
  by_basis: BasisShare[];
  unattributed: UnattributedEntry[];
  by_product: ProductCost[];
  by_place: PlaceCost[];
  by_period: PeriodCost[];
  farms: FinanceFarm[];
  no_valuation: NoValuationLine[];
  ledger_fallback_lines: number;
  reconciliation: { total: number; targets: number; unattributed: number; difference: number };
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

export interface RegistrationSuggestion {
  target: string;
  kind: "pest" | "disease" | null;
  weight: number;
  share: number;
}

export interface SuggestedRegistration {
  product: string;
  product_name: string;
  plans: number;
  suggestions: RegistrationSuggestion[];
}

const ALLOC = "upande_scp.serverscripts.reports.finance_allocation";

/** Spray Products with no registered targets, with what the usage history suggests. */
export function fetchSuggestedRegistrations(): Promise<SuggestedRegistration[]> {
  return call<SuggestedRegistration[]>(`${ALLOC}.suggested_registrations`, {});
}

/** Append targets to a Spray Product's default_targets (GM only). */
export function registerProductTargets(
  product: string,
  targets: string[],
): Promise<{ product: string; added: string[] }> {
  return call(`${ALLOC}.register_product_targets`, { product, targets: JSON.stringify(targets) });
}
