import type { ScoutingEntry } from "@/lib/scouting-types";
import type { ObsOption } from "@/lib/pest-heat";

/**
 * Hexagon colour for ONE pest or disease: the worst finding any visit to that hexagon logged.
 * Scouted and clean = low (green). Pests judge on the biggest count seen in one visit
 * (<= 3 low, <= 10 medium, more high - the stock severity scale); a disease is present or not,
 * so one positive visit is medium and two or more are high. Pure.
 */
export function triadObsColors(
  entries: ScoutingEntry[],
  obs: ObsOption | null,
  colors: [string, string, string],
): Map<string, string> {
  const worst = new Map<string, number>();
  for (const e of entries) {
    if (!e.triad) continue;
    let v = worst.get(e.triad) ?? 0;
    if (obs?.kind === "pest") {
      for (const p of e.pests_scouting_entry || []) if (p.pest === obs.name) v = Math.max(v, p.count || 1);
    } else if (obs) {
      for (const d of e.diseases_scouting_entry || []) if (d.disease === obs.name) v += 1;
    }
    worst.set(e.triad, v);
  }
  const out = new Map<string, string>();
  for (const [triad, v] of worst) {
    const isPest = obs?.kind === "pest";
    const band = isPest ? (v <= 3 ? 0 : v <= 10 ? 1 : 2) : v <= 0 ? 0 : v === 1 ? 1 : 2;
    out.set(triad, colors[band]);
  }
  return out;
}
