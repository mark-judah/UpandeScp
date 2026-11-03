/**
 * Spray Product rates by determinant. Mirrors
 * upande_scp/serverscripts/common/spray_rates.py.
 *
 *  - Water:     rate is per 1000 L of spray water
 *  - Hectarage: rate is per 10,000 m² of area
 */

import { call } from "./frappe";

export type RateBasis = "Water" | "Hectarage";

export interface RateRow {
  basis: RateBasis;
  lower: number;
  upper: number;
  crop: string | null;
  source: "crop" | "default";
}

export const RATE_BASES: RateBasis[] = ["Water", "Hectarage"];
export const WATER_UNIT_L = 1000;
export const HECTARAGE_UNIT_M2 = 10000;

export const BASIS_UNIT: Record<RateBasis, string> = {
  Water: "per 1000 L",
  Hectarage: "per 10,000 m²",
};

/** "Water · per 1000 L" */
export function basisLabel(basis: RateBasis): string {
  return `${basis} · ${BASIS_UNIT[basis]}`;
}

export function quantityFor(
  rate: number,
  basis: RateBasis,
  measures: { areaM2?: number | null; waterL?: number | null },
): number {
  if (basis === "Hectarage") {
    if (!measures.areaM2) throw new Error("A Hectarage rate needs the area (m²), which is missing.");
    return (rate * measures.areaM2) / HECTARAGE_UNIT_M2;
  }
  if (!measures.waterL) throw new Error("A Water rate needs the spray water volume (L), which is missing.");
  return (rate * measures.waterL) / WATER_UNIT_L;
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
