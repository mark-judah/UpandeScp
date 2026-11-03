/**
 * Open-field spray planning, the client side: which blocks are picked, when the
 * planning panel collapses, whether a block's plan is complete, and the draft
 * payload one block turns into. Pure, so it is tested without a page.
 *
 * A block is planned exactly like a greenhouse (same payload, same draft Work Order);
 * only the area comes from the block (Warehouse.custom_area_ha), and the water volume
 * is area x 1000 L/ha, the rate the single-block planner already used.
 *
 * Rates: each chemical carries a rate on a basis. A Hectarage rate (per 10,000 m2) turns
 * the block's area straight into a quantity; a Water rate (per 1000 L) uses the plan's
 * water volume. The panel prefers a Hectarage row of the product for the block's crop and
 * falls back to Water. The quantity sent is absolute: the server stores it verbatim.
 */
import type { DraftPayload } from "@/lib/spray-plan-creator-api";
import { quantityFor, type RateBasis, type RateRow } from "@/lib/spray-rates";

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
  /** what `rate` is measured against: per 1000 L of water, or per 10,000 m2 of block */
  basis: RateBasis;
  rate: number;
  /** the product's allowed range on this basis, when it has one */
  lower?: number | null;
  upper?: number | null;
  source?: string;
}

export interface BlockPlan {
  classification: "" | "Curative" | "Preventive";
  reason: string;
  team: string;
  kit: string;
  bom: string;
  targets: string[];
  /** typed area (ha); wins over the warehouse's when set */
  area: string;
  chemicals: BlockChemical[];
}

/** Litres of water per hectare, the constant the rose planner uses. */
export const WATER_VOLUME_RATE = 1000;
/** Square metres in a hectare. */
export const M2_PER_HA = 10000;
/** More than this many selected blocks and the panel shows one block at a time. */
export const COLLAPSE_ABOVE = 2;

export const emptyPlan = (): BlockPlan => ({
  classification: "",
  reason: "",
  team: "",
  kit: "",
  bom: "",
  targets: [],
  area: "",
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

export const waterVolumeFor = (areaHa: number) => areaHa * WATER_VOLUME_RATE;

/** Absolute quantity of one chemical on a block of `areaHa` hectares. */
export function chemicalQty(c: Pick<BlockChemical, "rate" | "basis">, areaHa: number): number {
  if (!(areaHa > 0) || !(c.rate > 0)) return 0;
  return quantityFor(c.rate, c.basis, { areaM2: areaHa * M2_PER_HA, waterL: waterVolumeFor(areaHa) });
}

/** A rate inside its range, or the nearest middle of it: the lower and upper averaged, or
 *  whichever of the two is set. */
export function defaultRate(row: Pick<RateRow, "lower" | "upper">): number {
  const lo = Number(row.lower) || 0;
  const up = Number(row.upper) || 0;
  const v = lo && up ? (lo + up) / 2 : lo || up;
  return Math.round(v * 10000) / 10000;
}

/**
 * The basis a product is planned on for a block: its Hectarage row (for the block's crop,
 * else a crop-less one) when there is one, otherwise null, meaning the caller keeps the
 * tank mix's own Water rate. `rows` arrive most specific first (crop, then any crop).
 */
export function hectarageRow(rows: RateRow[] | undefined): RateRow | null {
  return (rows || []).find((r) => r.basis === "Hectarage" && (Number(r.lower) || Number(r.upper))) ?? null;
}

/** The chemical as the panel starts it, given the product's rate rows. */
export function withRateRows(c: BlockChemical, rows: RateRow[] | undefined): BlockChemical {
  const h = hectarageRow(rows);
  if (h) return { ...c, basis: "Hectarage", rate: defaultRate(h), lower: Number(h.lower) || null, upper: Number(h.upper) || null };
  const w = (rows || []).find((r) => r.basis === "Water");
  return { ...c, basis: "Water", lower: w ? Number(w.lower) || null : null, upper: w ? Number(w.upper) || null : null };
}

/** True when a chemical's rate sits outside its product's range on its basis. */
export function rateOutOfRange(c: BlockChemical): boolean {
  if (!(c.rate > 0)) return false;
  if (c.lower != null && c.lower > 0 && c.rate < c.lower) return true;
  if (c.upper != null && c.upper > 0 && c.rate > c.upper) return true;
  return false;
}

/** What a block's plan still needs, in the words the panel shows. */
export function planProblems(plan: BlockPlan, areaHa: number): string[] {
  const out: string[] = [];
  if (!plan.classification) out.push("Preventive or Curative");
  else if (plan.classification === "Preventive" && plan.reason.trim().length < 20) out.push("a reason");
  if (plan.classification && plan.targets.length === 0) out.push("a target");
  if (!plan.team) out.push("team");
  if (!plan.bom) out.push("tank mix");
  if (!plan.chemicals.some((c) => c.item_code && c.rate > 0)) {
    if (plan.bom) out.push("a chemical");
  }
  if (!(areaHa > 0)) out.push("an area");
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
    custom_spray_team: plan.team || null,
    custom_water_ph: 0,
    custom_water_hardness: 0,
    custom_water_volume: waterVolumeFor(areaHa),
    custom_area: areaHa,
    custom_targets: plan.targets,
    production_item: plan.bom,
    custom_scheduled_application_time: when,
    chemicals: plan.chemicals
      .filter((c) => c.item_code && c.rate > 0)
      .map((c) => ({
        item_code: c.item_code,
        item_name: c.item_name,
        uom: c.stock_uom,
        source_warehouse: c.source || undefined,
        application_rate: chemicalQty(c, areaHa),
      })),
  };
}
