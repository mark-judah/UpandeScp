/** Samples for the outdoor pest heatmap: one observation, zeros included. */
import type { ScoutingEntry } from "./scouting-types";
import type { TrapLocations } from "./scouting-api";
import {
  buildGrid, DEFAULT_CUTS, idwField, makeFrame, polysFromGeojson, polysNear, quantileCuts, renderRgba,
  samplesToGrid, summarizeByOwner,
} from "./idw";

export const FIELD_RADIUS_M = 120;
export type FieldResult =
  | { kind: "ok"; grid: NonNullable<ReturnType<typeof buildGrid>>; cuts: ReturnType<typeof quantileCuts>;
      rgba: Uint8ClampedArray; blocks: ReturnType<typeof summarizeByOwner>; samples: number; traps: number; hits: number }
  | { kind: "no-samples" }   // nothing geo-tagged for this observation/crop
  | { kind: "no-blocks" };   // geo-tagged scouting, but no block polygon within reach

/** The whole field for one observation. Crop-agnostic: the entries and the
 *  traps handed in are already the route crop's; a crop with no block
 *  polygons (coffee before its blocks are keyed in) yields "no-blocks". */
export function computeField(
  entries: ScoutingEntry[],
  obs: { kind: ObsKind; name: string },
  blocks: { features: Array<{ geometry: any; properties?: any }> },
  fixedTraps: TrapLocations,
  tagOf: (props: any) => string,
  colors: [string, string, string],
): FieldResult {
  const pts = buildHeatPoints(entries, obs, fixedTraps);
  if (!pts.length) return { kind: "no-samples" };
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const lng0 = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
  const frame = makeFrame(lng0, lat0);
  const polys = polysNear(polysFromGeojson(blocks, tagOf), pts, FIELD_RADIUS_M, frame);
  const grid = buildGrid(polys, frame, 10, 40_000);
  if (!grid) return { kind: "no-blocks" };
  const field = idwField(grid, samplesToGrid(grid, pts), { k: 8, power: 2, radiusM: FIELD_RADIUS_M });
  const cuts = DEFAULT_CUTS;
  return {
    kind: "ok", grid, cuts, rgba: renderRgba(grid, field, cuts, colors, FIELD_RADIUS_M),
    blocks: summarizeByOwner(grid, field, cuts), samples: pts.length,
    traps: pts.filter((p) => p.trap).length, hits: pts.filter((p) => p.v > 0).length,
  };
}

export type ObsKind = "pest" | "disease";
export interface ObsOption {
  kind: ObsKind;
  name: string;
  count: number;
}
export interface HeatPoint {
  lng: number;
  lat: number;
  v: number;
  trap?: boolean;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}
function located(lat: number | null, lng: number | null) {
  return lat != null && lng != null && !(Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001);
}

/** Pests and diseases seen in the window, most-seen first. Pests rank ahead of
 *  diseases only by count; the caller defaults to the top pest. */
export function observationOptions(entries: ScoutingEntry[]): ObsOption[] {
  const m = new Map<string, ObsOption>();
  const add = (kind: ObsKind, name: string, n: number) => {
    const k = `${kind}|${name}`;
    const o = m.get(k);
    if (o) o.count += n;
    else m.set(k, { kind, name, count: n });
  };
  for (const e of entries) {
    for (const p of e.pests_scouting_entry || []) if (p.pest) add("pest", p.pest, p.count || 1);
    for (const d of e.diseases_scouting_entry || []) if (d.disease) add("disease", d.disease, 1);
    for (const t of e.trap_scouting_entry || []) if (t.pest && t.count) add("pest", t.pest, 0);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Disease row value: the severity when numeric, else 1. */
function diseaseValue(sev: unknown): number {
  const n = num(sev);
  return n != null && n > 0 ? n : 1;
}

/** One sample per ~1 m location (mean over visits), plus one per fixed trap
 *  (mean catch per reading) for pests. Scouted-and-not-found is 0. */
export function buildHeatPoints(
  entries: ScoutingEntry[],
  obs: { kind: ObsKind; name: string },
  fixedTraps: TrapLocations = {},
): HeatPoint[] {
  const loc = new Map<string, { lng: number; lat: number; sum: number; n: number }>();
  const traps = new Map<string, { sum: number; n: number }>();
  for (const e of entries) {
    if (obs.kind === "pest")
      for (const t of e.trap_scouting_entry || []) {
        if (t.pest !== obs.name || !t.trap || !fixedTraps[t.trap]) continue;
        const a = traps.get(t.trap) || { sum: 0, n: 0 };
        a.sum += t.count || 0;
        a.n++;
        traps.set(t.trap, a);
      }
    const lat = num(e.latitude), lng = num(e.longitude);
    if (!located(lat, lng)) continue;
    let v = 0;
    if (obs.kind === "pest") {
      for (const p of e.pests_scouting_entry || []) if (p.pest === obs.name) v += p.count || 1;
    } else {
      for (const d of e.diseases_scouting_entry || []) if (d.disease === obs.name) v += diseaseValue(d.severity_level);
    }
    const key = `${(lat as number).toFixed(5)},${(lng as number).toFixed(5)}`;
    const a = loc.get(key);
    if (a) {
      a.sum += v;
      a.n++;
    } else loc.set(key, { lng: lng as number, lat: lat as number, sum: v, n: 1 });
  }
  const out: HeatPoint[] = [...loc.values()].map((a) => ({ lng: a.lng, lat: a.lat, v: a.sum / a.n }));
  for (const [trap, a] of traps) {
    const f = fixedTraps[trap];
    out.push({ lng: f.lng, lat: f.lat, v: a.sum / a.n, trap: true });
  }
  return out;
}
