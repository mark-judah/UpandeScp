/**
 * Blocks, rows and hexagons (Triads) for the block-grown crops' maps.
 *
 * The server sends a regular hexagon as its centre plus one shared 6-corner template, and the
 * browser rebuilds the rings here (the same idea as the avocado tree rows: send two endpoints,
 * rebuild what lies between). The rebuilt hexagons go to MapLibre as ONE GeoJSON source, so
 * tiling/parsing runs in MapLibre's worker and only hexagons in view are drawn; layers carry a
 * minzoom so zoomed out only the always-on block boundaries paint. Colour is MapLibre
 * feature-state keyed by numeric id, so a recolour never rebuilds geometry.
 *
 * The payload is versioned: the version we hold goes back to the server, and an unchanged
 * answer means we reuse our IndexedDB copy.
 */
import { call } from "@/lib/frappe";
import { getPayload, setPayload } from "@/lib/idb";
import type { GeoJsonFC } from "@/lib/scouting-api";

export interface HexBlock {
  b: string;
  /** flat [row, number, x, y, ...] of regular hexagons, integer 1/q degree units */
  reg: number[];
  /** [name, row|null, number, deltaRing] for clipped / irregular hexagons */
  irr: Array<[string, number | null, number, number[]]>;
}
export interface HexPayload {
  q: number;
  tpl: number[][];
  blocks: HexBlock[];
}
export interface RowLine {
  b: string;
  r: number | null;
  n: number;
  a: [number, number];
  z: [number, number];
}
export interface FieldLayersPayload {
  version: string;
  blocks: GeoJsonFC;
  rows: RowLine[];
  hex: HexPayload;
}

export interface HexFeature {
  type: "Feature";
  id: number;
  properties: { n: string; b: string; r: number | null };
  geometry: { type: "Polygon"; coordinates: [number, number][][] };
}
export interface HexSet {
  fc: { type: "FeatureCollection"; features: HexFeature[] };
  /** triad name -> feature id, to colour by name */
  idByName: Map<string, number>;
  count: number;
}

export function triadName(block: string, row: number, num: number): string {
  return `${block} - Row ${row} - Triad ${num}`;
}

export function decodeHexes(hex: HexPayload | null | undefined): HexSet {
  const features: HexFeature[] = [];
  const idByName = new Map<string, number>();
  if (!hex || !hex.blocks) return { fc: { type: "FeatureCollection", features }, idByName, count: 0 };
  const { q, tpl } = hex;
  const push = (name: string, b: string, row: number | null, ring: [number, number][]) => {
    const id = features.length;
    idByName.set(name, id);
    features.push({
      type: "Feature",
      id,
      properties: { n: name, b, r: row },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  };
  for (const blk of hex.blocks) {
    const reg = blk.reg;
    for (let i = 0; i + 3 < reg.length; i += 4) {
      const x = reg[i + 2];
      const y = reg[i + 3];
      const ring: [number, number][] = tpl.map(([dx, dy]) => [(x + dx) / q, (y + dy) / q]);
      ring.push(ring[0]);
      push(triadName(blk.b, reg[i], reg[i + 1]), blk.b, reg[i], ring);
    }
    for (const [name, row, , delta] of blk.irr) {
      const ring: [number, number][] = [];
      let x = 0;
      let y = 0;
      for (let i = 0; i + 1 < delta.length; i += 2) {
        x += delta[i];
        y += delta[i + 1];
        ring.push([x / q, y / q]);
      }
      push(name, blk.b, row, ring);
    }
  }
  return { fc: { type: "FeatureCollection", features }, idByName, count: features.length };
}

export function rowLines(rows: RowLine[] | null | undefined, q: number): GeoJsonFC {
  return {
    type: "FeatureCollection",
    features: (rows || []).map((r) => ({
      type: "Feature" as const,
      geometry: {
        type: "LineString",
        coordinates: [
          [r.a[0] / q, r.a[1] / q],
          [r.z[0] / q, r.z[1] / q],
        ],
      },
      properties: { block: r.b, row: r.r, n: r.n },
    })),
  };
}

/* ---------- fetch with a versioned local copy ---------- */

const METHOD = "upande_scp.serverscripts.geo.field_geo.get_field_layers";
const IDB_VERSION = 1;
const IDB_MAX_AGE = 14 * 24 * 60 * 60 * 1000;
const memory = new Map<string, Promise<FieldLayersPayload>>();

export function fetchFieldLayers(farm = ""): Promise<FieldLayersPayload> {
  const hit = memory.get(farm);
  if (hit) return hit;
  const p = load(farm).catch((e) => {
    memory.delete(farm);
    throw e;
  });
  memory.set(farm, p);
  return p;
}

async function load(farm: string): Promise<FieldLayersPayload> {
  const key = `field_layers:${farm}`;
  let held: FieldLayersPayload | null = null;
  try {
    held = await getPayload<FieldLayersPayload>(key, IDB_VERSION, IDB_MAX_AGE);
  } catch {
    held = null;
  }
  const r = await call<FieldLayersPayload & { unchanged?: boolean }>(METHOD, {
    farm: farm || undefined,
    have: held?.version,
  });
  if (r?.unchanged && held) return held;
  const fresh: FieldLayersPayload = {
    version: r?.version ?? "",
    blocks: r?.blocks ?? { type: "FeatureCollection", features: [] },
    rows: r?.rows ?? [],
    hex: r?.hex ?? { q: 1e7, tpl: [], blocks: [] },
  };
  setPayload(key, fresh, IDB_VERSION).catch(() => undefined);
  return fresh;
}

export function resetFieldLayersCache(): void {
  memory.clear();
}
