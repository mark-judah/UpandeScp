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
  cost_group?: string;
  /** never used on a plan and nothing known about it: the GM is asked to set its group */
  unclassified?: boolean;
  plans: number;
  suggestions: RegistrationSuggestion[];
}

const ALLOC = "upande_scp.serverscripts.reports.finance_allocation";

/** Spray Products with no registered targets, with what the usage history suggests. */
export function fetchSuggestedRegistrations(): Promise<SuggestedRegistration[]> {
  return call<SuggestedRegistration[]>(`${ALLOC}.suggested_registrations`, {});
}

export const COST_GROUPS = [
  "Pest control",
  "Foliar",
  "Adjuvant",
  "pH buffer",
  "Hygiene & sanitation",
  "Post-harvest",
];

/** Change what a product's cost is for (GM only). */
export function setCostGroup(product: string, costGroup: string): Promise<{ product: string; cost_group: string }> {
  return call(`${ALLOC}.set_cost_group`, { product, cost_group: costGroup });
}

/** Append targets to a Spray Product's default_targets (GM only). */
export function registerProductTargets(
  product: string,
  targets: string[],
): Promise<{ product: string; added: string[] }> {
  return call(`${ALLOC}.register_product_targets`, { product, targets: JSON.stringify(targets) });
}


// ---------------------------------------------------------------------------
// Pest attribution: two tunnels (spray plans, direct material issues).
// Backend: upande_scp.serverscripts.reports.finance_api
// ---------------------------------------------------------------------------

export type PathKey = "spray" | "direct";
export type PathFilter = "spray" | "direct" | "both";

/** How a line was assigned. Recorded = declared on the plan; band* = derived (estimated). */
export type PestBasis =
  | "recorded"
  | "band1_ai_target"
  | "band1_ai_class"
  | "band2_alone"
  | "band3_radar"
  | "equal"
  | "foliar_equal"
  | "foliar_farm"
  | "non_pest"
  | "unclassified"
  | "unattributed";

export type Credibility = "recorded" | "derived" | "nonpest" | "unattributed";

export interface PestBasisRow {
  basis: PestBasis;
  value: number;
  share: number;
  kind: Credibility;
  label: string;
  accuracy: number | null;
}

export interface PestRow {
  target: string;
  kind: "pest" | "disease" | null;
  recorded: number;
  derived: number;
  value: number;
  share: number;
  /** spend-weighted estimated accuracy of the derived part, 0..1 */
  est_accuracy: number | null;
  basis: Partial<Record<PestBasis, number>>;
  products: { item_code: string; item_name: string; plan_uses?: number; value: number }[];
}

export interface PathProduct {
  item_code: string;
  item_name: string;
  nonpest: boolean;
  /** cost group: Pest control, Foliar, Adjuvant, pH buffer, Hygiene & sanitation, Post-harvest */
  group: string;
  /** spray plans (last year) that also used this product */
  plan_uses: number;
  value: number;
  from_mr: number;
  targets: { target: string; value: number }[];
}

export interface PathPlace {
  farm: string;
  greenhouse: string;
  cost_center: string | null;
  chemical: number;
  nonpest: number;
  value: number;
  targets: Record<string, number>;
}

export interface PathBlock {
  path: PathKey;
  total: number;
  chemical: {
    total: number;
    recorded: number;
    derived: number;
    unattributed: number;
    derived_accuracy: number | null;
    by_pest: PestRow[];
  };
  /** Non-pest inputs, one line per cost group: always separate from the pest cost. */
  nonpest: {
    total: number;
    groups: {
      group: string;
      /** how the group is treated, e.g. "split equally across the plan's targets" */
      treatment: string;
      value: number;
      by_target: { target: string; value: number }[];
      farm_level: number;
    }[];
  };
  by_basis: PestBasisRow[];
  by_product: PathProduct[];
  by_greenhouse: PathPlace[];
  plans_completed?: number;
  in_progress?: { plans: number; value: number };
  by_source?: { from_material_request: number; no_material_request: number };
  explain?: string;
}

export interface PestAttributionReport {
  filters: { from: string; to: string; paths: PathKey[]; pests: string[]; greenhouse: string };
  notes: string[];
  accuracy: Record<PathKey, Record<string, number>>;
  pest_options: string[];
  greenhouse_options: string[];
  spray?: PathBlock;
  direct?: PathBlock;
  combined: {
    total: number;
    spray: number;
    direct: number;
    line_total: number | null;
    ledger_total: number | null;
    ledger_difference: number | null;
    fallback_lines: number;
    reconciles: boolean | null;
  };
}

export interface PestAttributionFilters {
  from: string;
  to: string;
  path: PathFilter;
  pests: string[];
  greenhouse: string;
}

const FIN = "upande_scp.serverscripts.reports.finance_api";

export function fetchPestAttribution(f: PestAttributionFilters): Promise<PestAttributionReport> {
  return call<PestAttributionReport>(`${FIN}.pest_attribution_report`, {
    from_date: f.from,
    to_date: f.to,
    path: f.path,
    pests: JSON.stringify(f.pests),
    greenhouse: f.greenhouse,
  });
}

/** A GET URL that downloads the Excel file with the same filters as the page. */
export function pestAttributionExportUrl(f: PestAttributionFilters, perProduct: boolean): string {
  const q = new URLSearchParams({
    from_date: f.from,
    to_date: f.to,
    path: f.path,
    pests: JSON.stringify(f.pests),
    greenhouse: f.greenhouse,
    per_product: perProduct ? "1" : "0",
  });
  return `/api/method/${FIN}.export_pest_attribution?${q.toString()}`;
}

/** Credibility label for a basis, e.g. "Derived — est. 89%". Mirrors the server. */
export function credibilityLabel(
  basis: PestBasis,
  path: PathKey,
  accuracy: Record<PathKey, Record<string, number>>,
): { kind: Credibility; label: string; accuracy: number | null } {
  if (basis === "recorded") return { kind: "recorded", label: "Recorded", accuracy: 1 };
  if (basis === "foliar_equal") return { kind: "nonpest", label: "Split equally across plan targets", accuracy: null };
  if (basis === "unclassified") return { kind: "nonpest", label: "Unclassified \u2014 set its cost group", accuracy: null };
  if (basis === "foliar_farm" || basis === "non_pest") return { kind: "nonpest", label: "Not target-specific", accuracy: null };
  if (basis === "unattributed") return { kind: "unattributed", label: "Unattributed", accuracy: null };
  const acc = accuracy?.[path]?.[basis] ?? null;
  return {
    kind: "derived",
    label: acc != null ? `Derived \u2014 est. ${Math.round(acc * 100)}%` : "Derived",
    accuracy: acc,
  };
}
