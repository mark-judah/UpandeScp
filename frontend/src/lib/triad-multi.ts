import type { ScoutingEntry } from "@/lib/scouting-types";
import type { ObsOption } from "@/lib/pest-heat";
import { toneOf, type ToneBand } from "@/lib/pest-tone";

/**
 * Unit colours for SEVERAL pests/diseases (open-field Solid blocks): per unit, the worst band any
 * selected observation reached there (same scale as triadObsColors: a pest on its biggest count in
 * one visit, <= 3 low, <= 10 medium, more high; a disease one visit medium, two or more high), drawn
 * in THAT observation's own colour at the band's opacity. Ties on band go to the larger raw value,
 * then the name, so the pick is stable. A scouted unit with nothing selected is the faint clean wash
 * in `cleanColor`. Pure.
 */
export function multiUnitColors(
  entries: ScoutingEntry[],
  selected: ObsOption[],
  colorOf: (o: ObsOption) => string,
  keyOf: (e: ScoutingEntry) => string | null | undefined,
  cleanColor: string,
): Map<string, string> {
  const best = new Map<string, { band: 0 | 1 | 2 | -1; v: number; o: ObsOption | null }>();
  const perUnit = new Map<string, Map<string, number>>();
  for (const e of entries) {
    const key = keyOf(e);
    if (!key) continue;
    if (!best.has(key)) best.set(key, { band: -1, v: 0, o: null });
    let m = perUnit.get(key);
    if (!m) perUnit.set(key, (m = new Map()));
    for (const o of selected) {
      const id = `${o.kind}|${o.name}`;
      let v = m.get(id) ?? 0;
      if (o.kind === "pest") {
        for (const p of e.pests_scouting_entry || []) if (p.pest === o.name) v = Math.max(v, p.count || 1);
      } else {
        for (const d of e.diseases_scouting_entry || []) if (d.disease === o.name) v += 1;
      }
      m.set(id, v);
    }
  }
  const out = new Map<string, string>();
  for (const [key, m] of perUnit) {
    let top: { band: 0 | 1 | 2; v: number; o: ObsOption } | null = null;
    for (const o of selected) {
      const v = m.get(`${o.kind}|${o.name}`) ?? 0;
      if (v <= 0) continue;
      const band = (o.kind === "pest" ? (v <= 3 ? 0 : v <= 10 ? 1 : 2) : v === 1 ? 1 : 2) as 0 | 1 | 2;
      if (!top || band > top.band || (band === top.band && (v > top.v || (v === top.v && o.name < top.o.name))))
        top = { band, v, o };
    }
    out.set(key, top ? toneOf(colorOf(top.o), top.band as ToneBand) : toneOf(cleanColor, "clean"));
  }
  return out;
}
