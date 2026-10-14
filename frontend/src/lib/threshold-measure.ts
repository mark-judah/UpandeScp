/**
 * Measures and bands for the Thresholds editor and the Trends reference lines.
 * Mirrors serverscripts/common/threshold_bands.py (thresholds spec D1, D3);
 * the server re-checks everything on save, this only spares a round trip.
 */
import type { ThresholdsBundle } from "./thresholds-api";

export type Measure = "Percentage" | "Count";

/** The bands that are set must rise strictly; all-zero is unconfigured. */
export function bandsAscending(low: number, moderate: number, high: number): boolean {
  const values = [low, moderate, high].map((v) => Number(v) || 0);
  if (values.some((v) => v < 0)) return false;
  const set = values.filter((v) => v > 0);
  return set.every((v, i) => i === 0 || set[i - 1] < v);
}

/** `readingType` omitted = the row's own figure. Under a Count row a tick-box
 *  (or range) stage is judged as a share: a tick is not a count. */
export function effectiveMeasure(rowMeasure: Measure, readingType?: string | null): Measure {
  if (rowMeasure !== "Count") return "Percentage";
  if (readingType == null) return "Count";
  return readingType === "Count" ? "Count" : "Percentage";
}

/** "%" for a Percentage; "per zone" / "per tree" for a Count. */
export function unitFor(measure: Measure, station: string = "zone"): string {
  return measure === "Count" ? `per ${station || "zone"}` : "%";
}

/** "30%" / "5 per zone" */
export function formatBandValue(value: number, unit: string): string {
  return unit === "%" ? `${value}%` : `${value} ${unit}`;
}

export interface MeasuredBand {
  low?: number;
  moderate?: number;
  high?: number;
  measure: Measure;
  unit: string;
}

function usable(b: { low: number; moderate: number; high: number }): boolean {
  const set = (b.low || 0) > 0 || (b.moderate || 0) > 0 || (b.high || 0) > 0;
  return set && bandsAscending(b.low, b.moderate, b.high);
}

/** `${kind}::${name}::${stage}` (stage "" = the row) → its band, measure and
 *  unit. Unset and misordered bands are left out, as the server leaves them out. */
export function thresholdMapFromBundle(bundle: ThresholdsBundle | null): Map<string, MeasuredBand> {
  const m = new Map<string, MeasuredBand>();
  if (!bundle) return m;
  const station = bundle.station || "zone";
  const add = (key: string, b: { low: number; moderate: number; high: number }, measure: Measure) => {
    if (!usable(b)) return;
    m.set(key, { low: b.low, moderate: b.moderate, high: b.high, measure, unit: unitFor(measure, station) });
  };
  for (const p of bundle.pests) {
    const rowMeasure: Measure = p.measure === "Count" ? "Count" : "Percentage";
    add(`pest::${p.pest}::`, p, rowMeasure);
    for (const s of p.stages) add(`pest::${p.pest}::${s.stage}`, s, effectiveMeasure(rowMeasure, s.reading_type));
  }
  for (const d of bundle.diseases) {
    add(`disease::${d.disease}::`, d, "Percentage");
    for (const s of d.stages) add(`disease::${d.disease}::${s.stage}`, s, "Percentage");
  }
  return m;
}

/** One line for a Count band on a chart whose axis is a share. */
export function countBandNote(b: MeasuredBand): string {
  const parts = (
    [["Low", b.low], ["Mod", b.moderate], ["High", b.high]] as Array<[string, number | undefined]>
  )
    .filter(([, v]) => Number(v) > 0)
    .map(([label, v]) => `${label} ${v}`);
  return `Count thresholds (${b.unit}): ${parts.join(" · ")} — Trends plots the share of stations, so they are not drawn here`;
}
