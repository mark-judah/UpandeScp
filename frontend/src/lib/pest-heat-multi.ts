/** The Application Floor Plan field for SEVERAL pests/diseases at once.
 *
 *  One shared grid; each selected observation gets its own IDW field on it
 *  (same default bands, so values compare directly). A cell's value is the
 *  WORST of the selected observations there (the max), and it takes the colour
 *  of that dominant observation, at the opacity of its band (the open field's own
 *  tone ramp). A cell where everything selected is at zero is the faint clean wash.
 *
 *  The block ranking uses that same worst-of field (mean over the block's
 *  filled cells), so the list order matches what the map shows. Summing would
 *  add pest counts to disease severities, which are different units. */
import type { ScoutingEntry } from "./scouting-types";
import type { TrapLocations } from "./scouting-api";
import {
  buildGrid, classOf, DEFAULT_CUTS, idwField, makeFrame, polysFromGeojson, polysNear, samplesToGrid,
  summarizeByOwner, type Field,
} from "./idw";
import { buildHeatPoints, FIELD_RADIUS_M, type FieldResult, type ObsKind } from "./pest-heat";

export type Obs = { kind: ObsKind; name: string };
export const obsKeyOf = (o: Obs) => `${o.kind}|${o.name}`;

export type OkField = Extract<FieldResult, { kind: "ok" }>;
export type MultiField =
  | (OkField & {
      /** block tag -> key of the observation that is the worst on most of its filled area */
      dominant: Map<string, string>;
      /** key -> cells it dominates (for the legend) */
      share: Map<string, number>;
    })
  | { kind: "no-samples" }
  | { kind: "no-blocks" };

function rgbOf(h: string): [number, number, number] {
  const s = h.replace("#", "");
  const f = s.length === 3 ? s.replace(/./g, "$&$&") : s;
  const n = parseInt(f, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function computeMultiField(
  entries: ScoutingEntry[],
  selected: Obs[],
  blocks: { features: Array<{ geometry: any; properties?: any }> },
  fixedTraps: TrapLocations,
  tagOf: (props: any) => string,
  colorOf: (o: Obs) => string,
  noneColor: string,
  /** Opacity per band (mutara paints a pest in its own colour at several strengths). */
  alphas: { low: number; mid: number; high: number; clean: number },
): MultiField {
  const per = selected.map((o) => ({ o, pts: buildHeatPoints(entries, o, fixedTraps) }));
  const all = per.flatMap((p) => p.pts);
  if (!all.length) return { kind: "no-samples" };
  const lat0 = all.reduce((s, p) => s + p.lat, 0) / all.length;
  const lng0 = all.reduce((s, p) => s + p.lng, 0) / all.length;
  const frame = makeFrame(lng0, lat0);
  const polys = polysNear(polysFromGeojson(blocks, tagOf), all, FIELD_RADIUS_M, frame);
  const grid = buildGrid(polys, frame, 10, 40_000);
  if (!grid) return { kind: "no-blocks" };

  const n = grid.cols * grid.rows;
  const value = new Float32Array(n).fill(NaN);
  const dist = new Float32Array(n).fill(Infinity);
  const who = new Int16Array(n).fill(-1);
  per.forEach(({ pts }, k) => {
    if (!pts.length) return;
    const f = idwField(grid, samplesToGrid(grid, pts), { k: 8, power: 2, radiusM: FIELD_RADIUS_M });
    for (let i = 0; i < n; i++) {
      const v = f.value[i];
      if (Number.isNaN(v)) continue;
      if (Number.isNaN(value[i]) || v > value[i]) {
        value[i] = v;
        if (v > 0) who[i] = k;
      }
      if (f.dist[i] < dist[i]) dist[i] = f.dist[i];
    }
  });
  const field: Field = { value, dist };
  const cuts = DEFAULT_CUTS;

  const rgb = per.map((p) => rgbOf(colorOf(p.o)));
  const none = rgbOf(noneColor);
  const rgba = new Uint8ClampedArray(n * 4);
  const share = new Map<string, number>();
  const byBlock = new Map<number, Map<number, number>>();
  for (let r = 0; r < grid.rows; r++)
    for (let c = 0; c < grid.cols; c++) {
      const i = r * grid.cols + c;
      if (grid.owner[i] < 0) continue;
      const v = value[i];
      const o = i * 4;
      if (Number.isNaN(v)) {
        if ((r + c) % 3 === 0) { rgba[o] = 90; rgba[o + 1] = 90; rgba[o + 2] = 84; rgba[o + 3] = 70; }
        continue;
      }
      const k = who[i];
      const col = k >= 0 ? rgb[k] : none;
      const cls = classOf(v, cuts);
      const strength = v <= 0 || k < 0 ? alphas.clean : cls === 2 ? alphas.high : cls === 1 ? alphas.mid : alphas.low;
      const t = Math.min(1, dist[i] / FIELD_RADIUS_M);
      rgba[o] = col[0]; rgba[o + 1] = col[1]; rgba[o + 2] = col[2];
      rgba[o + 3] = Math.round(255 * strength * (1 - 0.6 * t));
      if (k >= 0) {
        const key = obsKeyOf(per[k].o);
        share.set(key, (share.get(key) || 0) + 1);
        const m = byBlock.get(grid.owner[i]) ?? new Map<number, number>();
        m.set(k, (m.get(k) || 0) + 1);
        byBlock.set(grid.owner[i], m);
      }
    }

  const dominant = new Map<string, string>();
  grid.tags.forEach((tag, ownerIdx) => {
    const m = byBlock.get(ownerIdx);
    if (!m) return;
    let bk = -1, bc = -1;
    for (const [k, cnt] of m)
      if (cnt > bc || (cnt === bc && obsKeyOf(per[k].o) < obsKeyOf(per[bk].o))) { bk = k; bc = cnt; }
    dominant.set(tag, obsKeyOf(per[bk].o));
  });

  return {
    kind: "ok", grid, cuts, rgba, blocks: summarizeByOwner(grid, field, cuts), samples: all.length,
    traps: all.filter((p) => p.trap).length, hits: all.filter((p) => p.v > 0).length, dominant, share,
  };
}

/** Block ranking: the worst-of mean, then the red share. */
export function rankBlocks<T extends { tag: string; mean: number; redShare: number; coverage: number }>(blocks: T[]): T[] {
  return blocks.filter((b) => b.tag && b.coverage > 0).sort((x, y) => y.mean - x.mean || y.redShare - x.redShare);
}
