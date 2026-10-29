/**
 * The 3D view of the Application Plan map (spec 2026-10-29 §5): each scouting value is a sphere on
 * its unit (hexagon, tree, visit point), in the pest's colour, its radius growing with the value.
 * The pure parts — which spheres, how big, how they breathe — live here; SpheresLayer draws them.
 */
import type { ScoutingEntry } from "@/lib/scouting-types";
import { entryPoint, unitKey } from "@/lib/unit-key";

/** Radius (metres) of a single find, and the cap. A hexagon is ~3 m across. */
export const MIN_SPHERE_M = 0.6;
export const MAX_SPHERE_M = 3;
/** The value at which a sphere reaches full size. */
export const SPHERE_CAP = 60;

/** Radius in metres for a value: 0 for nothing, then log-scaled from MIN to MAX, capped. */
export function sphereRadius(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const t = Math.min(1, Math.log10(1 + value) / Math.log10(1 + SPHERE_CAP));
  return Math.round((MIN_SPHERE_M + (MAX_SPHERE_M - MIN_SPHERE_M) * t) * 1000) / 1000;
}

export interface SpherePoint {
  key: string;
  lng: number;
  lat: number;
  value: number;
}

/** One sphere per unit with a find: its worst visit for the observation (a pest's count, a
 *  disease's visits), at the hexagon's centre when `centreOf` knows the unit, else the visit. */
export function spherePoints(
  entries: ScoutingEntry[],
  obs: { kind: "pest" | "disease"; name: string } | null,
  centreOf: (unit: string) => [number, number] | null,
): SpherePoint[] {
  if (!obs) return [];
  const by = new Map<string, SpherePoint>();
  for (const e of entries) {
    const key = unitKey(e);
    if (!key) continue;
    let v = 0;
    if (obs.kind === "pest") {
      for (const p of e.pests_scouting_entry || []) if (p.pest === obs.name) v = Math.max(v, p.count || 1);
    } else {
      for (const d of e.diseases_scouting_entry || []) if (d.disease === obs.name) v += 1;
    }
    if (v <= 0) continue;
    const prev = by.get(key);
    if (prev) {
      prev.value = obs.kind === "pest" ? Math.max(prev.value, v) : prev.value + v;
      continue;
    }
    const at = centreOf(key) ?? entryPoint(e);
    if (!at) continue;
    by.set(key, { key, lng: at[0], lat: at[1], value: v });
  }
  return [...by.values()];
}

/** Scale of a sphere at time `ms`: a slow, gentle breath (±6 %) offset by `phase` (0–1) so the
 *  field never beats in lockstep; 1 (still) under reduced motion. */
export function spherePulse(ms: number, phase: number, reducedMotion: boolean): number {
  if (reducedMotion) return 1;
  return 1 + 0.06 * Math.sin((ms / 2600 + phase) * Math.PI * 2);
}
