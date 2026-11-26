/**
 * Open-field spray planning, the client side: which blocks are picked, when the
 * planning panel collapses, whether a block's plan is complete, and the draft
 * payload one block turns into. Pure, so it is tested without a page.
 *
 * A block is planned exactly like a greenhouse (same payload, same draft Work Order);
 * only the area comes from the block. The water volume is a number the planner types.
 *
 * Rates: each product is measured by its own determinant. An Area rate (per N of an Area
 * UOM) turns the block's area into a quantity; a Water rate (per N of a Volume UOM) uses the
 * typed water volume, which is required only when the mix holds a Water product. A mix can
 * hold both. The panel prefers an Area row of the product for the block's crop and falls
 * back to Water. The quantity sent is absolute: the server stores it verbatim.
 */
import type { DraftPayload } from "@/lib/spray-plan-creator-api";
import { needsWaterBasis, perBaseOf, pickRow, quantityFor, type RateBasis, type RateRow } from "@/lib/spray-rates";

export interface OpenFieldBlock {
  name: string;
  label: string;
  farm: string | null;
  crop: string | null;
  crop_label: string | null;
  area_ha: number;
  cost_center: string | null;
}

export interface OpenFieldGroup {
  kind: "Pivot" | "Section" | null;
  name: string | null;
  label: string;
  blocks: OpenFieldBlock[];
}

export interface BlockChemical {
  item_code: string;
  item_name?: string;
  stock_uom?: string;
  /** what `rate` is measured against: an amount of water, or an amount of block area */
  basis: RateBasis;
  /** the rate, in the unit of `per_qty` x `per_uom` (the stock UOM per that amount) */
  rate: number;
  per_qty?: number;
  per_uom?: string;
  /** that denominator in Litre / Square Meter, from the server; absent = legacy 1000 L / 10,000 m2 */
  per_base?: number;
  /** the product's allowed range on this basis, when it has one */
  lower?: number | null;
  upper?: number | null;
  source?: string;
  /** stable row id (the shared plan form keys rows by it) */
  rowId?: string;
  /** batch reserved for this row (custom_batch_no on the Work Order Item) */
  batch_no?: string;
  /** set once the store's availability is known: the item must name a batch there */
  batch_required?: boolean;
  is_fertilizer?: boolean;
  /** on-hand balance per warehouse, as get_bom_details / get_chemical_stock_balances give it */
  balances?: Record<string, number>;
  uoms?: Array<{ uom: string; conversion_factor: number }>;
  item_group?: string;
  /** greenhouse plans keep the derived total here (rate x water / 1000) */
  stock_qty?: number;
  /** on hand at the source less every saved open plan's reservation (set once known) */
  stock_free?: number;
}

export interface BlockPlan {
  classification: "" | "Curative" | "Preventive";
  reason: string;
  team: string;
  kit: string;
  /** how the product goes on; a Work Order select */
  method: string;
  bom: string;
  targets: string[];
  /** typed area (ha); wins over the warehouse's when set */
  area: string;
  /** typed spray water (L); needed only when the mix holds a Water product */
  water: string;
  chemicals: BlockChemical[];
  /** this plan's Scheduled Application ("YYYY-MM-DD HH:mm:ss"); blank = the planner's default */
  scheduledAt?: string;
  /** this plan's crew (seeded from the team, editable): custom_spray_plan_team_members */
  members?: { employee: string; employee_name?: string; designation?: string | null; role: string }[];
  /** greenhouse plans: the tank's water pH and hardness, seeded from the tank mix */
  waterPh?: string;
  waterHardness?: string;
}

/** Method of application options, exactly as the Work Order select has them. */
export const METHODS = ["Spraying (foliar)", "Dusting", "Chemigation"];
export const DEFAULT_METHOD = METHODS[0];
/** Square metres in a hectare. */
export const M2_PER_HA = 10000;
const WATER_PER_UNIT_L = 1000;
/** More than this many selected blocks and the panel shows one block at a time. */
export const COLLAPSE_ABOVE = 2;

export const emptyPlan = (): BlockPlan => ({
  classification: "",
  reason: "",
  team: "",
  kit: "",
  method: DEFAULT_METHOD,
  bom: "",
  targets: [],
  area: "",
  water: "",
  chemicals: [],
});

export const shouldCollapse = (selected: number) => selected > COLLAPSE_ABOVE;

export function groupState(selected: string[], blocks: OpenFieldBlock[]): "none" | "some" | "all" {
  const n = blocks.filter((b) => selected.includes(b.name)).length;
  return n === 0 ? "none" : n === blocks.length ? "all" : "some";
}

/** Select every block of a group, or clear the group when all are already chosen. */
export function toggleGroup(selected: string[], blocks: OpenFieldBlock[]): string[] {
  if (groupState(selected, blocks) === "all") {
    const drop = new Set(blocks.map((b) => b.name));
    return selected.filter((n) => !drop.has(n));
  }
  const have = new Set(selected);
  return [...selected, ...blocks.map((b) => b.name).filter((n) => !have.has(n))];
}

export const toggleBlock = (selected: string[], name: string) =>
  selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name];

/** The area used for a block: the typed one, else the warehouse's. */
export function effectiveArea(block: OpenFieldBlock, plan: BlockPlan): number {
  const typed = parseFloat(plan.area);
  return Number.isFinite(typed) && typed > 0 ? typed : block.area_ha || 0;
}

/** The water typed for a block's plan, in litres; 0 when blank. */
export function typedWater(plan: Pick<BlockPlan, "water">): number {
  const v = parseFloat(plan.water);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** True when some product in the plan is measured against water, so the volume is required. */
export function planNeedsWater(plan: Pick<BlockPlan, "chemicals">): boolean {
  return needsWaterBasis(plan.chemicals.filter((c) => c.item_code && c.rate > 0).map((c) => c.basis));
}

/** Absolute quantity of one chemical on `areaHa` hectares sprayed with `waterL` litres. Each
 *  product uses its own determinant: Area against the area, Water against the water. 0 while
 *  the measure it needs is missing. */
export function chemicalQty(
  c: Pick<BlockChemical, "rate" | "basis" | "per_base">,
  areaHa: number,
  waterL: number,
): number {
  if (!(c.rate > 0)) return 0;
  const measure = c.basis === "Hectarage" ? areaHa : waterL;
  if (!(measure > 0)) return 0;
  return quantityFor(c.rate, c.basis, { areaM2: areaHa * M2_PER_HA, waterL }, perBaseOf(c.basis, c));
}

/** A rate inside its range, or the nearest middle of it: the lower and upper averaged, or
 *  whichever of the two is set. */
export function defaultRate(row: Pick<RateRow, "lower" | "upper">): number {
  const lo = Number(row.lower) || 0;
  const up = Number(row.upper) || 0;
  const v = lo && up ? (lo + up) / 2 : lo || up;
  return Math.round(v * 10000) / 10000;
}

/** The chemical as the panel starts it, given the product's rate rows. An Area row wins
 *  (opening at the middle of its range); otherwise the tank mix's own per-1000 L rate is kept,
 *  rescaled into the Water row's unit when the product has one. */
export function withRateRows(c: BlockChemical, rows: RateRow[] | undefined): BlockChemical {
  const row = pickRow(rows, true);
  const unit = row ? { per_qty: row.per_qty, per_uom: row.per_uom, per_base: row.per_base } : {};
  if (row && row.basis === "Hectarage") {
    return { ...c, ...unit, basis: "Hectarage", rate: defaultRate(row), lower: Number(row.lower) || null, upper: Number(row.upper) || null };
  }
  // The BOM's rate is per 1000 L; a Water row set per another amount scales it to that unit.
  const k = row?.per_base ? row.per_base / WATER_PER_UNIT_L : 1;
  const rate = Math.round(c.rate * k * 1e6) / 1e6;
  return { ...c, ...unit, basis: "Water", rate, lower: row ? Number(row.lower) || null : null, upper: row ? Number(row.upper) || null : null };
}

/** True when a chemical's rate sits outside its product's range on its basis. */
export function rateOutOfRange(c: BlockChemical): boolean {
  if (!(c.rate > 0)) return false;
  if (c.lower != null && c.lower > 0 && c.rate < c.lower) return true;
  if (c.upper != null && c.upper > 0 && c.rate > c.upper) return true;
  return false;
}

/** A field of a block's plan form that can be missing. */
export type PlanField =
  | "classification" | "reason" | "targets" | "team" | "bom" | "chemicals"
  | "area" | "water" | "batch" | "stock" | "schedule" | "method";

export interface FieldProblem {
  field: PlanField;
  /** the short form the block header and "Still to plan" use ("team", "tank mix") */
  text: string;
  /** the line under the field */
  message: string;
}

/** What a block's plan still needs, field by field: the single source for the header's
 *  "Needs …", the form's required marks and the submit gate. */
export function planFieldProblems(plan: BlockPlan, areaHa: number, elsewhere?: Record<string, number>): FieldProblem[] {
  const out: FieldProblem[] = [];
  const add = (field: PlanField, text: string, message: string) => out.push({ field, text, message });
  if (!plan.classification) add("classification", "Preventive or Curative", "Choose Preventive or Curative.");
  else if (plan.classification === "Preventive" && (plan.reason || "").trim().length < 20)
    add("reason", "a reason", "Give a reason of at least 20 characters.");
  if (plan.classification && (plan.targets || []).length === 0) add("targets", "a target", "Pick at least one target.");
  if (!plan.team) add("team", "team", "Pick a spray team.");
  if (plan.method === "") add("method", "MOA", "Pick the method of application.");
  if (plan.scheduledAt === "") add("schedule", "a scheduled time", "Set the scheduled date and time.");
  if (!plan.bom) add("bom", "tank mix", "Pick a tank mix, or make one with New tank mix.");
  if (!plan.chemicals.some((c) => c.item_code && c.rate > 0)) {
    if (plan.bom) add("chemicals", "a chemical", "Add at least one chemical with a rate.");
  }
  if (!(areaHa > 0)) add("area", "the block area", "Enter the block area.");
  if (planNeedsWater(plan) && typedWater(plan) <= 0)
    add("water", "the water volume", "Enter the spray water: a product in the mix is dosed per water.");
  const noBatch = missingBatchRows(plan);
  if (noBatch.length) {
    const names = noBatch.map((c) => c.item_name || c.item_code).join(", ");
    add("batch", `a batch for ${names}`, `Pick a batch for ${names}.`);
  }
  const short = shortStockRows(plan, areaHa, elsewhere);
  if (short.length) {
    const names = short.map((r) => r.name).join(", ");
    add("stock", `stock for ${names}`, `${names} ${short.length === 1 ? "is" : "are"} short on stock.`);
  }
  return out;
}

/** What a block's plan still needs, in the words the panel shows. */
export function planProblems(plan: BlockPlan, areaHa: number, elsewhere?: Record<string, number>): string[] {
  return planFieldProblems(plan, areaHa, elsewhere).map((p) => p.text);
}

export interface ShortRow {
  name: string;
  source: string;
  avail: number;
  need: number;
}

/** Rows the store cannot cover, the roses gate: free stock at the source (on hand less
 *  saved open plans) less the plan's other rows of the item and what the other selected
 *  blocks draw of it. A stock-loaded row with no source is short. Rows whose stock is
 *  not known yet are not judged. */
export function shortStockRows(
  plan: Pick<BlockPlan, "chemicals" | "water">,
  areaHa: number,
  elsewhere?: Record<string, number>,
): ShortRow[] {
  const water = typedWater(plan);
  const out: ShortRow[] = [];
  plan.chemicals.forEach((c, i) => {
    if (!c.item_code) return;
    const need = chemicalQty(c, areaHa, water);
    if (!(need > 0)) return;
    const name = c.item_name || c.item_code;
    if (!c.source) {
      // a row loaded from stock data (it has balances) but with no store is short
      if (c.balances) out.push({ name, source: "", avail: 0, need });
      return;
    }
    if (c.stock_free == null) return;
    let others = Number(elsewhere?.[stockKey(c.source, c.item_code)] ?? 0);
    plan.chemicals.forEach((o, j) => {
      if (j !== i && o.item_code === c.item_code && o.source === c.source) others += chemicalQty(o, areaHa, water);
    });
    const avail = Math.max(0, c.stock_free - others);
    if (avail < need) out.push({ name, source: c.source, avail, need });
  });
  return out;
}

/** Batch-tracked rows with no batch picked: the same gate the greenhouse plan applies. */
export function missingBatchRows(plan: Pick<BlockPlan, "chemicals">): BlockChemical[] {
  return plan.chemicals.filter((c) => c.item_code && c.batch_required && !c.batch_no);
}

/** The key availability and reservations are held under: one item at one store. */
export const stockKey = (source: string | undefined, item: string) => `${source || ""}::${item}`;

/** What one block's plan draws, per item at its store ("store::item" -> quantity). */
export function usageByStore(plan: Pick<BlockPlan, "chemicals" | "water">, areaHa: number): Record<string, number> {
  const out: Record<string, number> = {};
  const water = typedWater(plan);
  for (const c of plan.chemicals) {
    if (!c.item_code || !c.source) continue;
    const q = chemicalQty(c, areaHa, water);
    if (q > 0) out[stockKey(c.source, c.item_code)] = (out[stockKey(c.source, c.item_code)] || 0) + q;
  }
  return out;
}

/** The unsaved quantities the OTHER selected blocks draw, per item at its store: a block's
 *  Available nets these off as well as the saved drafts, so two blocks in one batch cannot
 *  both count the same stock. */
export function reservedElsewhere(
  block: string,
  blocks: OpenFieldBlock[],
  plans: Record<string, BlockPlan | undefined>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of blocks) {
    const p = plans[b.name];
    if (b.name === block || !p) continue;
    for (const [k, q] of Object.entries(usageByStore(p, effectiveArea(b, p)))) out[k] = (out[k] || 0) + q;
  }
  return out;
}

export function toDraftPayload(
  block: OpenFieldBlock,
  plan: BlockPlan,
  areaHa: number,
  when: string,
): DraftPayload {
  return {
    custom_greenhouse: block.name,
    custom_classification: plan.classification as "Curative" | "Preventive",
    custom_preventive_reason: plan.classification === "Preventive" ? plan.reason.trim() : "",
    custom_spray_type: "Full",
    custom_scope: "Whole Block",
    custom_kit: plan.kit || null,
    custom_method_of_application: plan.method || DEFAULT_METHOD,
    custom_spray_team: plan.team || null,
    ...(plan.members?.length
      ? { custom_spray_plan_team_members: plan.members.map((m) => ({ employee: m.employee, role: m.role })) }
      : {}),
    custom_water_ph: 0,
    custom_water_hardness: 0,
    custom_water_volume: typedWater(plan),
    custom_area: areaHa,
    custom_targets: plan.targets,
    production_item: plan.bom,
    custom_scheduled_application_time: plan.scheduledAt || when,
    chemicals: plan.chemicals
      .filter((c) => c.item_code && c.rate > 0)
      .map((c) => ({
        item_code: c.item_code,
        item_name: c.item_name,
        uom: c.stock_uom,
        source_warehouse: c.source || undefined,
        batch_no: c.batch_no || null,
        application_rate: chemicalQty(c, areaHa, typedWater(plan)),
      })),
  };
}
