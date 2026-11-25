/**
 * Blocks and triangles (Triads) for the block-grown crops' maps.
 *
 * The server sends a full triangle as its Hexa centre plus one shared 3-corner template per slot, and the
 * browser rebuilds the rings here (the same idea as the avocado tree rows: send two endpoints,
 * rebuild what lies between). The rebuilt triangles go to MapLibre as ONE GeoJSON source, so
 * tiling/parsing runs in MapLibre's worker and only triangles in view are drawn; layers carry a
 * minzoom so zoomed out only the always-on block boundaries paint. Colour is MapLibre
 * feature-state keyed by numeric id, so a recolour never rebuilds geometry.
 *
 * The payload is versioned: the version we hold goes back to the server, and an unchanged
 * answer means we reuse our IndexedDB copy.
 */
import { call } from "@/lib/frappe";
import { getPayload, setPayload } from "@/lib/idb";
import type { GeoJsonFC } from "@/lib/scouting-api";

export interface TriBlock {
  /** slot "1".."6" -> offsets [dx,dy] x3 of the triangle's corners from the Hexa centre */
  tpl: Record<string, Array<[number, number]>>;
  /** flat [hexa, t, x, y, ...] of regular triangles, x,y = the Hexa centre, integer 1/q degrees */
  reg: number[];
  /** [hexa|null, t|null, deltaRing, name?] for clipped / irregular triangles */
  irr: Array<[number | null, number | null, number[], string?]>;
}
export interface TriPayload {
  q: number;
  blocks: Record<string, TriBlock>;
}
export interface FieldLayersPayload {
  version: string;
  blocks: GeoJsonFC;
  tri: TriPayload;
}

export interface TriadFeature {
  type: "Feature";
  id: number;
  properties: { name: string; block: string; hexa: number | null; t: number | null };
  geometry: { type: "Polygon"; coordinates: [number, number][][] };
}
export interface TriadSet {
  fc: { type: "FeatureCollection"; features: TriadFeature[] };
  /** triad name -> feature id, to colour by name */
  idByName: Map<string, number>;
  count: number;
}

export function triadName(block: string, hexa: number, t: number): string {
  return `${block} - Hexa ${hexa} - Triad ${t}`;
}

export function decodeTriads(tri: TriPayload | null | undefined): TriadSet {
  const features: TriadFeature[] = [];
  const idByName = new Map<string, number>();
  if (!tri || !tri.blocks) return { fc: { type: "FeatureCollection", features }, idByName, count: 0 };
  const { q } = tri;
  const push = (name: string, block: string, hexa: number | null, t: number | null, ring: [number, number][]) => {
    const id = features.length;
    idByName.set(name, id);
    features.push({
      type: "Feature",
      id,
      properties: { name, block, hexa, t },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  };
  for (const [block, blk] of Object.entries(tri.blocks)) {
    const reg = blk.reg;
    for (let i = 0; i + 3 < reg.length; i += 4) {
      const [hexa, t, x, y] = [reg[i], reg[i + 1], reg[i + 2], reg[i + 3]];
      const corners = blk.tpl[String(t)];
      if (!corners) continue;
      const ring: [number, number][] = corners.map(([dx, dy]) => [(x + dx) / q, (y + dy) / q]);
      ring.push(ring[0]);
      push(triadName(block, hexa, t), block, hexa, t, ring);
    }
    for (const [hexa, t, delta, own] of blk.irr) {
      const ring: [number, number][] = [];
      let x = 0;
      let y = 0;
      for (let i = 0; i + 1 < delta.length; i += 2) {
        x += delta[i];
        y += delta[i + 1];
        ring.push([x / q, y / q]);
      }
      const name = own ?? (hexa != null && t != null ? triadName(block, hexa, t) : "");
      if (name) push(name, block, hexa, t, ring);
    }
  }
  return { fc: { type: "FeatureCollection", features }, idByName, count: features.length };
}

/** The outer edge a->b of every regular (full) triangle: six segments make a Hexa's outline. */
export function hexaEdges(tri: TriPayload | null | undefined): GeoJsonFC {
  const out: GeoJsonFC["features"] = [];
  if (!tri || !tri.blocks) return { type: "FeatureCollection", features: out };
  const { q } = tri;
  for (const [block, blk] of Object.entries(tri.blocks)) {
    const reg = blk.reg;
    for (let i = 0; i + 3 < reg.length; i += 4) {
      const [hexa, t, x, y] = [reg[i], reg[i + 1], reg[i + 2], reg[i + 3]];
      const c = blk.tpl[String(t)];
      if (!c) continue;
      out.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [(x + c[1][0]) / q, (y + c[1][1]) / q],
            [(x + c[2][0]) / q, (y + c[2][1]) / q],
          ],
        },
        properties: { block, hexa, t },
      });
    }
  }
  return { type: "FeatureCollection", features: out };
}

/* ---------- fetch with a versioned local copy ---------- */

const METHOD = "upande_scp.serverscripts.geo.field_geo.get_field_layers";
const IDB_VERSION = 2;
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
    tri: r?.tri ?? { q: 1e7, blocks: {} },
  };
  setPayload(key, fresh, IDB_VERSION).catch(() => undefined);
  return fresh;
}

export function resetFieldLayersCache(): void {
  memory.clear();
}
