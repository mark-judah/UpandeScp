/**
 * Spray compliance — the server decides whether a plan's products suit its
 * targets and each other; this module only fetches and presents that decision.
 */
import { call } from "@/lib/frappe";

const M = "upande_scp.serverscripts.spray_compliance.api";

export type RuleMode = "Off" | "Warn" | "Block (GM override)" | "Block";
export interface Violation {
  rule: string; mode: RuleMode; overridden: boolean; message: string;
  products: string[]; targets: string[]; codes: string[]; key: string;
}
export interface CoverageRow { target: string; products: string[] }
export interface CheckResult {
  violations: Violation[]; coverage: CoverageRow[]; blocking: boolean; needs_override: boolean;
  /** "Check failed": the server could not run the check (approval review only). */
  status: "Clean" | "Warnings" | "Awaiting Override" | "Overridden" | "Blocked" | "Check failed";
  can_override: boolean;
  /** Set when status is "Check failed". */
  message?: string;
}
export interface ProductEligibility {
  item: string; name: string; eligible: boolean; worst_mode: RuleMode; reasons: string[];
  /** Rule keys the product breaks; "target_match" = not registered for the targets. */
  rules: string[];
  codes: string[]; targets: string[]; non_target: boolean;
}
export interface BomEligibility {
  bom: string; eligible: boolean; status: CheckResult["status"]; worst_mode: RuleMode;
  coverage: CoverageRow[]; reasons: string[];
}
export interface OverrideInput { key: string; rule: string; reason: string }

/** One override recorded on a plan. `honoured` is false when the giver lacked authority. */
export interface RecordedOverride {
  rule: string; subject: string; reason: string;
  overridden_by: string; overridden_on: string; honoured: boolean;
}
/** `get_approval_review().compliance`: the check plus the overrides on file. */
export interface ReviewCompliance extends CheckResult { overrides: RecordedOverride[] }

const RULE_ORDER = ["target_match", "target_coverage", "same_moa_in_mix", "moa_rotation",
  "max_sprays", "known_resistance", "tank_mix_incompatible"];
const LABELS: Record<string, string> = {
  target_match: "Product targets", target_coverage: "Target coverage",
  same_moa_in_mix: "Same group in one tank", moa_rotation: "Group rotation",
  max_sprays: "Spray limits", known_resistance: "Known resistance",
  tank_mix_incompatible: "Tank-mix incompatibility",
};

export const ruleLabel = (rule: string) => LABELS[rule] ?? rule;

/* `when` = the plan's scheduled spray time ("YYYY-MM-DD HH:mm:ss"); the server
 * judges history and spray limits as of then. Omitted, it judges as of now. */

export function checkSprayPlan(args: {
  greenhouse: string; targets: string[]; items: string[]; overrides?: OverrideInput[]; excludeWo?: string;
  when?: string;
}): Promise<CheckResult> {
  return call<CheckResult>(`${M}.check_spray_plan`, {
    greenhouse: args.greenhouse, targets: JSON.stringify(args.targets), items: JSON.stringify(args.items),
    overrides: JSON.stringify(args.overrides ?? []), exclude_wo: args.excludeWo ?? "", when: args.when ?? "",
  });
}

export function eligibleProducts(args: {
  greenhouse: string; targets: string[]; items: string[]; candidates?: string[]; when?: string;
}): Promise<ProductEligibility[]> {
  return call<ProductEligibility[]>(`${M}.eligible_products`, {
    greenhouse: args.greenhouse, targets: JSON.stringify(args.targets), items: JSON.stringify(args.items),
    candidates: JSON.stringify(args.candidates ?? []), when: args.when ?? "",
  });
}

export function eligibleBoms(args: {
  greenhouse: string; targets: string[]; boms: string[]; when?: string;
}): Promise<BomEligibility[]> {
  return call<BomEligibility[]>(`${M}.eligible_boms`, {
    greenhouse: args.greenhouse, targets: JSON.stringify(args.targets), boms: JSON.stringify(args.boms),
    when: args.when ?? "",
  });
}

/** How the Add-chemical list shows one search result (spec §3): products not
 *  registered for the targets are hidden unless "Show all" is on; any other
 *  rule-breaker is greyed with its reason and stays pickable unless a rule
 *  hard-blocks it. A result the server has not ranked is shown as is. */
export type PickerState = "ok" | "greyed" | "blocked" | "hidden";
export function pickerState(e: ProductEligibility | undefined, showAll: boolean): PickerState {
  if (!e) return "ok";
  if (offTarget(e) && !showAll) return "hidden";
  if (e.worst_mode === "Block") return "blocked";
  return e.eligible ? "ok" : "greyed";
}
const offTarget = (e: ProductEligibility) => (e.rules ?? []).includes("target_match");

/** Whether "Show all" changes anything for these results. */
export const pickerFilters = (rows: ProductEligibility[]) => rows.some(offTarget);

/** Violations grouped by rule in engine order. A rule this module does not
 *  know yet lands in a trailing "Other" group rather than disappearing. */
export function groupViolations(vs: Violation[]) {
  const known = RULE_ORDER.map((rule) => ({ rule, label: ruleLabel(rule), items: vs.filter((v) => v.rule === rule) }));
  const other = { rule: "other", label: "Other", items: vs.filter((v) => !RULE_ORDER.includes(v.rule)) };
  return [...known, other].filter((g) => g.items.length);
}

export function modeBadge(mode: RuleMode, overridden: boolean): { text: string; tone: "red" | "amber" | "muted" | "green" } {
  if (overridden) return { text: "Overridden", tone: "green" };
  if (mode === "Block") return { text: "Blocked", tone: "red" };
  if (mode === "Block (GM override)") return { text: "Needs GM override", tone: "amber" };
  return { text: "Warning", tone: "muted" };
}

export function saveGate(r: CheckResult | null): { state: "ok" | "warn" | "override" | "blocked"; reason?: string } {
  if (!r) return { state: "ok" };
  const hard = r.violations.filter((v) => v.mode === "Block");
  if (hard.length) return { state: "blocked", reason: hard.map((v) => v.message).join("\n") };
  if (r.needs_override) return { state: "override" };
  return { state: r.violations.length ? "warn" : "ok" };
}

export function sortBoms<T extends { name: string }>(boms: T[], elig: Record<string, { eligible: boolean } | undefined>): T[] {
  const rank = (b: T) => (elig[b.name] === undefined ? 2 : elig[b.name]!.eligible ? 0 : 1);
  return [...boms].sort((a, b) => rank(a) - rank(b));
}

/** GM only. Records overrides on a plan awaiting approval and returns the fresh check. */
export function overrideSprayPlan(wo: string, overrides: OverrideInput[]): Promise<CheckResult> {
  return call<CheckResult>(`${M}.override_spray_plan`, { wo, overrides: JSON.stringify(overrides) });
}

/** One row of the "Suggested products" list (server: `spray_compliance.suggest`). */
export interface SuggestedProduct {
  item_code: string;
  item_name: string;
  stock_uom?: string;
  item_group?: string;
  uoms?: Array<{ uom: string; conversion_factor: number }>;
  is_fertilizer: boolean;
  /** Lower rate limit per 1000 L for the crop, or null when none is configured. */
  default_rate: number | null;
  score: number;
  /** 1-5 */
  dots: number;
  eligible: boolean;
  worst_mode: RuleMode;
  warnings: string[];
  covered_targets: string[];
  last_used_days: number | null;
  usable_batches: number;
  batch_tracked: boolean;
  free_qty: number;
  cost_per_ha: number | null;
  reason: string;
}
export interface SuggestedProducts {
  suggestions: SuggestedProduct[];
  considered: number;
  unavailable: number;
  blocked: number;
  /** What is still missing before suggestions can be made. */
  needs: "targets" | "greenhouse" | "store" | null;
}

export function suggestProducts(args: {
  targets: string[]; greenhouses: string[]; sourceWarehouse: string; currentItems: string[];
  crop?: string; when?: string;
}): Promise<SuggestedProducts> {
  return call<SuggestedProducts>(`${M}.suggest_products`, {
    targets: JSON.stringify(args.targets), greenhouses: JSON.stringify(args.greenhouses),
    source_warehouse: args.sourceWarehouse, current_items: JSON.stringify(args.currentItems),
    crop: args.crop ?? "", when: args.when ?? "",
  });
}
