/**
 * Severity bands as the server judged them, for the avocado Jobsheet.
 *
 * The band is computed server-side (`scouting/thresholds_check.figures_for_houses`)
 * from the same figure and bands the dashboards, the alerts and the weekly block
 * sheet use (thresholds spec D8): the share of scouted trees carrying a pest
 * (Percentage) or the average count per scouted tree (Count). The browser only
 * formats it. Count per hectare stays a plain fact beside it.
 */

/** "" means judged and below the lowest band — NOT the same as `null`, which
 *  means it cannot be judged at all. */
export type Band = "high" | "moderate" | "low" | "" | null;

export const BAND_LABEL: Record<"high" | "moderate" | "low", string> = {
  high: "High",
  moderate: "Moderate",
  low: "Low",
};

/** One hue, three depths — the same ramp the weekly sheet shades with. */
export const BAND_COLOR: Record<"high" | "moderate" | "low", string> = {
  high: "#9b1c1c",
  moderate: "#cf4a4a",
  low: "#e08585",
};

export interface HouseFigure {
  measure: "Percentage" | "Count";
  /** "%", "per tree" or "per zone" */
  unit: string;
  value: number | null;
  margin: number | null;
  reliability: "Good" | "Fair" | "Low";
  sections_scouted: number;
  sections_total: number;
  band: Band;
  action: "Alarming" | "Spray advised" | "Scout first" | null;
  week: string;
}

/** "33.3%" / "1.2 per tree" — the figure the band was judged on. */
export function judgedLabel(f: HouseFigure | null | undefined): string | null {
  if (!f || f.value == null) return null;
  return f.unit === "%" ? `${f.value}%` : `${f.value} ${f.unit}`;
}

/** The week's count over the block's hectares (2 dp); null without an area. */
export function perHectare(count: number, areaHa: number | null | undefined): number | null {
  if (!areaHa) return null;
  return Math.round((Number(count || 0) / Number(areaHa)) * 100) / 100;
}

/** Sort key so the worst pressure leads. Unjudged pests sort below judged
 *  ones rather than being dropped — the count is still a fact. */
export function bandRank(band: Band): number {
  if (band === "high") return 3;
  if (band === "moderate") return 2;
  if (band === "low") return 1;
  return 0;
}
