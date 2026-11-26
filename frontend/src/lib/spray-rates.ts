/**
 * Spray Product rates: stock UOM per an amount of Water or Area. Mirrors
 * upande_scp/serverscripts/common/spray_rates.py.
 *
 *  - Water:     the rate is per `per_qty` of a Volume UOM, against the typed water volume
 *  - Hectarage: the rate is per `per_qty` of an Area UOM, against the area sprayed
 */

import { call } from "./frappe";

export type RateBasis = "Water" | "Hectarage";

/**
 * One rate row of a product: a dose in the product's stock UOM per `per_qty` of `per_uom`.
 * `per_base` is that denominator in Litre (Water) or Square Meter (Hectarage), worked out
 * by the server from ERPNext's UOM conversions, so the client never needs the table.
 * A row without a unit (older server) reads as the legacy 1000 L / 10,000 m².
 */
export interface RateRow {
  basis: RateBasis;
  lower: number;
  upper: number;
  crop: string | null;
  source: "crop" | "default";
  per_qty?: number;
  per_uom?: string;
  per_base?: number;
  stock_uom?: string;
  line?: string;
}

export const RATE_BASES: RateBasis[] = ["Water", "Hectarage"];
export const WATER_UNIT_L = 1000;
export const HECTARAGE_UNIT_M2 = 10000;

/** What each determinant is called to a user: Hectarage reads as Area. */
export const BASIS_NAME: Record<RateBasis, string> = { Water: "Water", Hectarage: "Area" };

export const BASIS_UNIT: Record<RateBasis, string> = {
  Water: "per 1000 L",
  Hectarage: "per 10,000 m²",
};

/** "Water · per 1000 L" */
export function basisLabel(basis: RateBasis): string {
  return `${BASIS_NAME[basis]} · ${BASIS_UNIT[basis]}`;
}

/** The denominator of a rate in Litre / Square Meter (legacy unit when the row has none). */
export function perBaseOf(basis: RateBasis, row?: Pick<RateRow, "per_base"> | null): number {
  return row?.per_base && row.per_base > 0 ? row.per_base : basis === "Hectarage" ? HECTARAGE_UNIT_M2 : WATER_UNIT_L;
}

/** "per 1000 Litre of water", "per 1 Acre of area", or the legacy label for a bare row. */
export function perLabel(basis: RateBasis, row?: Pick<RateRow, "per_qty" | "per_uom"> | null): string {
  if (!row?.per_uom) return BASIS_UNIT[basis];
  const noun = basis === "Hectarage" ? "of area" : "of water";
  const qty = row.per_qty && row.per_qty !== 1 ? `${row.per_qty} ` : "";
  return `per ${qty}${row.per_uom} ${noun}`;
}

/** Absolute quantity: rate x measure / per_base. Mirrors spray_rates.quantity_for. */
export function quantityFor(
  rate: number,
  basis: RateBasis,
  measures: { areaM2?: number | null; waterL?: number | null },
  perBase?: number | null,
): number {
  if (basis === "Hectarage") {
    if (!measures.areaM2) throw new Error("An Area rate needs the area (m²), which is missing.");
    return (rate * measures.areaM2) / (perBase || HECTARAGE_UNIT_M2);
  }
  if (!measures.waterL) throw new Error("A Water rate needs the spray water volume (L), which is missing.");
  return (rate * measures.waterL) / (perBase || WATER_UNIT_L);
}

/** The rate (in the row's unit) an absolute quantity amounts to; null without the measure.
 *  Mirrors spray_rates.rate_from_quantity. */
export function rateFromQuantity(
  qty: number,
  basis: RateBasis,
  perBase: number | null | undefined,
  measures: { areaM2?: number | null; waterL?: number | null },
): number | null {
  const m = basis === "Hectarage" ? measures.areaM2 : measures.waterL;
  if (!m) return null;
  return (qty * (perBase || (basis === "Hectarage" ? HECTARAGE_UNIT_M2 : WATER_UNIT_L))) / m;
}

/** 'ok' | 'below' | 'above', as spray_rates.rate_status (rate rounded to 6 places). */
export function rateStatus(
  rate: number | null,
  row: Pick<RateRow, "lower" | "upper"> | null | undefined,
): "ok" | "below" | "above" {
  if (rate == null || !row) return "ok";
  const r = Math.round(rate * 1e6) / 1e6;
  if (row.lower && r < row.lower) return "below";
  if (row.upper && r > row.upper) return "above";
  return "ok";
}

/**
 * The row a plan measures a product by: block plans take an Area row when there is one,
 * greenhouse plans a Water row; either falls back to the first. Mirrors spray_rates.pick_row.
 */
export function pickRow(rows: RateRow[] | undefined, preferArea: boolean): RateRow | null {
  const list = (rows || []).filter((r) => Number(r.lower) || Number(r.upper));
  const want: RateBasis = preferArea ? "Hectarage" : "Water";
  return list.find((r) => r.basis === want) ?? list[0] ?? null;
}

/** True when any of the given determinants is Water (an all-Area mix needs no water volume). */
export function needsWaterBasis(bases: RateBasis[]): boolean {
  return bases.some((b) => b === "Water");
}

/** "With 2000 L of water: 0.0012 Litre per litre" (stock UOM per litre of spray water). */
export function dilutionLine(qty: number, waterL: number, stockUom?: string): string | null {
  if (!(waterL > 0) || !(qty > 0)) return null;
  const per = qty / waterL;
  const shown = per >= 0.01 ? per.toFixed(3) : per.toPrecision(2);
  return `With ${Math.round(waterL * 100) / 100} L of water: ${shown} ${stockUom || "units"} per litre`;
}

export async function fetchSprayProductRates(
  itemCodes: string[],
  crop?: string | null,
): Promise<Record<string, RateRow[]>> {
  if (!itemCodes.length) return {};
  const out = await call<Record<string, RateRow[]>>(
    "upande_scp.serverscripts.common.spray_rates.get_spray_product_rates",
    { item_codes: JSON.stringify(itemCodes), crop: crop || "" },
  );
  return out || {};
}
