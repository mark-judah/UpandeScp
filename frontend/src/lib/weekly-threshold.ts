/**
 * Heatmap colours from the same figure the cumulative alerts use.
 *
 * The server's `cumulative_per_ha.get_round_per_ha` gives, per block and observation, the
 * cumulative count over the current ISO week per hectare and the threshold (per ha) that
 * raises the alert. This file only classifies that figure for the map; it computes no second
 * formula. A block reads:
 *
 *   0  none / low   below MEDIUM_SHARE of the threshold
 *   1  medium       at least MEDIUM_SHARE of the threshold, not yet at it
 *   2  high         at or over the threshold: the alert fires (same `>=` as the server)
 *
 * With several observations selected the block takes its worst one. A block with no
 * configured threshold for any selected observation is left out, so the map keeps its
 * data-driven colouring there.
 */
import type { RoundPerHa } from "./cumulative-api";

/** Share of the threshold at which a block turns from none/low to medium. */
export const MEDIUM_SHARE = 0.5;

export type WeeklyClass = 0 | 1 | 2;

export function weeklyClass(perHa: number | null | undefined, threshold: number | null | undefined): WeeklyClass | null {
  if (!(Number(threshold) > 0) || perHa == null) return null;
  if (perHa >= Number(threshold)) return 2;
  return perHa >= Number(threshold) * MEDIUM_SHARE ? 1 : 0;
}

export interface BlockWeekly {
  cls: WeeklyClass;
  perHa: number;
  threshold: number;
  /** the observation that decided the class */
  kind: "pest" | "disease";
  observation: string;
}

/** Each block's class for the selected observations (null `selected` = every observation). */
export function blockWeekly(
  round: Pick<RoundPerHa, "blocks"> | null | undefined,
  selected: Array<{ kind: string; name: string }> | null,
): Map<string, BlockWeekly> {
  const out = new Map<string, BlockWeekly>();
  const want = selected ? new Set(selected.map((o) => `${o.kind}|${o.name}`)) : null;
  for (const b of round?.blocks ?? []) {
    for (const f of b.observations) {
      if (want && !want.has(`${f.kind}|${f.observation}`)) continue;
      const cls = weeklyClass(f.per_ha, f.threshold_per_ha);
      if (cls == null) continue;
      const ratio = (f.per_ha ?? 0) / f.threshold_per_ha;
      const prev = out.get(b.block);
      if (!prev || cls > prev.cls || (cls === prev.cls && ratio > prev.perHa / prev.threshold))
        out.set(b.block, { cls, perHa: f.per_ha ?? 0, threshold: f.threshold_per_ha, kind: f.kind, observation: f.observation });
    }
  }
  return out;
}
