/**
 * Which severity band an observed count falls in.
 *
 * This mirrors `_band` in `serverscripts/reports/block_weekly_report.py` on
 * purpose, and the two must stay in step: the jobsheet and the weekly sheet are
 * read by the same people about the same blocks in the same week, and a pest
 * the sheet paints red while the jobsheet shows plain is worse than neither
 * saying anything. Same thresholds, same column for the area, same rules about
 * what cannot be judged.
 */

import type { ThresholdPestRow } from "./thresholds-api";

/** "" means judged and below the lowest band — which is NOT the same as `null`,
 *  meaning it cannot be judged at all. Drawing those two alike is the mistake
 *  this type exists to prevent. */
export type Band = "high" | "moderate" | "low" | "" | null;

export const BAND_LABEL: Record<"high" | "moderate" | "low", string> = {
  high: "High",
  moderate: "Moderate",
  low: "Low",
};

/** The severity ramp already used by the heat map's legend, so a block that
 *  reads red on the map reads red in the panel beside it. */
export const BAND_COLOR: Record<"high" | "moderate" | "low", string> = {
  high: "#dc2626",
  moderate: "#e9a23b",
  low: "#5bb45d",
};

export interface BandSpec {
  unit?: string;
  low?: number;
  moderate?: number;
  high?: number;
}

/**
 * `areaHa` is the block's hectares, or null/0 when it has none.
 *
 * Returns null — "not assessable" — when there is no threshold, when the unit
 * is Per Hectare and the block has no area (dividing by a missing denominator
 * invents a figure), or when the unit is "Per Zone %", which is a greenhouse
 * measure that a block cannot answer.
 *
 * Bands are inclusive of their threshold: the Pest Filter field descriptions
 * define it as the value AT WHICH severity becomes that band.
 */
export function bandFor(
  count: number,
  spec: BandSpec | undefined | null,
  areaHa: number | null | undefined,
): Band {
  if (!spec) return null;
  const low = Number(spec.low || 0);
  const moderate = Number(spec.moderate || 0);
  const high = Number(spec.high || 0);
  if (!(low || moderate || high)) return null;

  const unit = spec.unit || "";
  let value = Number(count || 0);
  if (unit === "Per Hectare") {
    if (!areaHa) return null;
    value = value / Number(areaHa);
  } else if (unit === "Per Zone %") {
    return null;
  }

  if (high && value >= high) return "high";
  if (moderate && value >= moderate) return "moderate";
  if (low && value >= low) return "low";
  return "";
}

/** The figure the band was judged on, for showing beside the raw count. */
export function judgedValue(
  count: number,
  spec: BandSpec | undefined | null,
  areaHa: number | null | undefined,
): { value: number; suffix: string } | null {
  if (!spec) return null;
  if ((spec.unit || "") === "Per Hectare") {
    if (!areaHa) return null;
    return { value: Number(count || 0) / Number(areaHa), suffix: "/ha" };
  }
  if ((spec.unit || "") === "Per Zone %") return null;
  return { value: Number(count || 0), suffix: "" };
}

/** Index a thresholds bundle by pest name for lookup while rendering. */
export function specsByPest(
  rows: ThresholdPestRow[] | undefined,
): Record<string, BandSpec> {
  const out: Record<string, BandSpec> = {};
  for (const r of rows || []) {
    if (!r?.pest) continue;
    out[r.pest] = {
      unit: r.unit,
      low: r.low,
      moderate: r.moderate,
      high: r.high,
    };
  }
  return out;
}

/** Sort key so the worst pressure leads the list. Unjudged pests sort below
 *  judged ones rather than being dropped — the count is still a fact. */
export function bandRank(band: Band): number {
  if (band === "high") return 3;
  if (band === "moderate") return 2;
  if (band === "low") return 1;
  return 0;
}
