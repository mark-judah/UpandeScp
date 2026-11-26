/**
 * Blocks and triangles (Triads) for the block-grown crops' maps, as the lattice they were cut on.
 *
 * `hexa_grid.cut` lays a regular lattice over a block (UTM, origin at the outline's north-west
 * corner, pointy-top hexas of circumradius `side`, rows 1.5·side apart north → south, odd rows
 * shifted half a width east, slot t = [centre, V(30°+60°(t-1)), V(30°+60°t)], hexas numbered
 * 1..N in (row, col) order). The server (serverscripts/geo/field_lattice.py) sends per block the
 * lattice — each hexa's (row, col) and which slots are kept / full — plus explicit rings only for
 * the clipped edge pieces, and an affine map from the block's lattice frame to Web-Mercator
 * metres. The whole farm is a few hundred KB; the GPU draws every full triangle as one instance
 * of a single triangle (pages/maps/FieldLatticeLayer.ts), and the edge pieces as a small GeoJSON
 * layer. The maths here mirrors `field_lattice.decode_block` (the exact-match test runs both on
 * one fixture).
 */
import { call } from "@/lib/frappe";
import { getPayload, setPayload } from "@/lib/idb";

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

/* ---------- the lattice encoding ---------- */

export interface LatticeBlock {
  epsg?: number;
  /** lattice origin in UTM metres (informational: everything below is relative to it) */
  o?: [number, number];
  side?: number;
  /** ideal lattice metres (relative to o) -> EPSG:3857 metres: X = a0 x + a1 y + a2, Y = a3 x + a4 y + a5 */
  aff?: [number, number, number, number, number, number];
  /** per hexa in hexa order: [row delta, col, kept | full << 6] */
  h: number[];
  /** clipped pieces: [hexa index, t, ring in cm relative to the hexa centre (lattice frame)] */
  e: Array<[number, number, number[]]>;
  /** triads off the lattice: [name, ring in 1e-7 degrees, delta-encoded] */
  x: Array<[string, number[]]>;
  /** explicit hexa numbers when they are not 1..N in lattice order */
  no?: number[];
}

/** A decoded block: hexa centres in the lattice frame (metres from o) and their slot masks. */
export interface LatticeCells {
  n: number;
  x: Float64Array;
  y: Float64Array;
  row: Int32Array;
  col: Int32Array;
  kept: Uint8Array;
  full: Uint8Array;
  no: Int32Array;
  /** row * 2^20 + col (offset) -> cell index */
  at: Map<number, number>;
}

const SQRT3 = Math.sqrt(3);
const WEB_R = 6378137;
const cellKey = (r: number, c: number) => r * 1048576 + (c + 524288);

export function latticeCells(enc: LatticeBlock): LatticeCells {
  const n = Math.floor(enc.h.length / 3);
  const side = enc.side ?? 5;
  const w = SQRT3 * side;
  const dy = 1.5 * side;
  const cells: LatticeCells = {
    n,
    x: new Float64Array(n),
    y: new Float64Array(n),
    row: new Int32Array(n),
    col: new Int32Array(n),
    kept: new Uint8Array(n),
    full: new Uint8Array(n),
    no: new Int32Array(n),
    at: new Map(),
  };
  let r = 0;
  for (let i = 0; i < n; i++) {
    r += enc.h[i * 3];
    const c = enc.h[i * 3 + 1];
    const bits = enc.h[i * 3 + 2];
    cells.row[i] = r;
    cells.col[i] = c;
    cells.x[i] = c * w + ((r & 1) * w) / 2;
    cells.y[i] = -r * dy;
    cells.kept[i] = bits & 63;
    cells.full[i] = bits >> 6;
    cells.no[i] = enc.no ? enc.no[i] : i + 1;
    cells.at.set(cellKey(r, c), i);
  }
  return cells;
}

/** Corner v (0 = centre, 1, 2) of slot t's triangle, relative to the hexa centre. */
export function slotCorner(side: number, t: number, v: number): [number, number] {
  if (v === 0) return [0, 0];
  const a = ((30 + 60 * (t - 1 + v - 1)) * Math.PI) / 180;
  return [side * Math.cos(a), side * Math.sin(a)];
}

/** Lattice-frame metres -> [lng, lat]. */
export function latticeToLngLat(enc: LatticeBlock, x: number, y: number): [number, number] {
  const a = enc.aff!;
  const X = a[0] * x + a[1] * y + a[2];
  const Y = a[3] * x + a[4] * y + a[5];
  return [(X / WEB_R) * (180 / Math.PI), (2 * Math.atan(Math.exp(Y / WEB_R)) - Math.PI / 2) * (180 / Math.PI)];
}

/** [lng, lat] -> lattice-frame metres (the inverse of the block's affine). */
export function lngLatToLattice(enc: LatticeBlock, lng: number, lat: number): [number, number] {
  const a = enc.aff!;
  const X = ((lng * Math.PI) / 180) * WEB_R - a[2];
  const Y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * WEB_R - a[5];
  const det = a[0] * a[4] - a[1] * a[3];
  return [(a[4] * X - a[1] * Y) / det, (-a[3] * X + a[0] * Y) / det];
}

/** Every triangle of the block as an open ring of [lng, lat], keyed "hexa_no:t" (tests, gallery). */
export function latticeTriangles(enc: LatticeBlock): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  if (!enc.h.length || !enc.aff) return out;
  const cells = latticeCells(enc);
  const side = enc.side ?? 5;
  for (let i = 0; i < cells.n; i++)
    for (let t = 1; t <= 6; t++)
      if ((cells.full[i] >> (t - 1)) & 1)
        out.set(
          `${cells.no[i]}:${t}`,
          [0, 1, 2].map((v) => {
            const [dx, dy] = slotCorner(side, t, v);
            return latticeToLngLat(enc, cells.x[i] + dx, cells.y[i] + dy);
          }),
        );
  for (const [i, t, ring] of enc.e) {
    const pts: [number, number][] = [];
    for (let j = 0; j + 1 < ring.length; j += 2) pts.push(latticeToLngLat(enc, cells.x[i] + ring[j] / 100, cells.y[i] + ring[j + 1] / 100));
    out.set(`${cells.no[i]}:${t}`, pts);
  }
  return out;
}

function inRing(p: [number, number], ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The triangle under a point: lattice coordinates by the same maths the grid was cut with — the
 * nearest hexa centre (a point's hexagon on a hexagonal lattice) and the slot by bearing — then
 * the clipped piece's own polygon when that slot is an edge piece. Null when no triangle is there.
 */
export function latticePick(enc: LatticeBlock, cells: LatticeCells, lng: number, lat: number): { no: number; t: number } | null {
  if (!enc.aff || !cells.n) return null;
  const side = enc.side ?? 5;
  const w = SQRT3 * side;
  const dy = 1.5 * side;
  const [x, y] = lngLatToLattice(enc, lng, lat);
  const r0 = Math.round(-y / dy);
  // The point's hexagon is the nearest lattice centre (with or without a numbered hexa there).
  let br = 0;
  let bc = 0;
  let bestD = Infinity;
  for (let r = r0 - 1; r <= r0 + 1; r++) {
    const c0 = Math.round(x / w - (r & 1) / 2);
    for (let c = c0 - 1; c <= c0 + 1; c++) {
      const d = (x - (c * w + ((r & 1) * w) / 2)) ** 2 + (y + r * dy) ** 2;
      if (d < bestD) {
        bestD = d;
        br = r;
        bc = c;
      }
    }
  }
  const best = cells.at.get(cellKey(br, bc));
  if (best === undefined) return null;
  const dx = x - cells.x[best];
  const dyy = y - cells.y[best];
  const deg = ((Math.atan2(dyy, dx) * 180) / Math.PI + 360 - 30) % 360;
  const t = Math.floor(deg / 60) + 1;
  if ((cells.full[best] >> (t - 1)) & 1) return { no: cells.no[best], t };
  if (!((cells.kept[best] >> (t - 1)) & 1)) return null;
  for (const [i, tt, ring] of enc.e) {
    if (i !== best || tt !== t) continue;
    const poly: Array<[number, number]> = [];
    for (let j = 0; j + 1 < ring.length; j += 2) poly.push([ring[j] / 100, ring[j + 1] / 100]);
    return inRing([dx, dyy], poly) ? { no: cells.no[best], t } : null;
  }
  return null;
}

/** The block's triangles as GeoJSON features (the gallery's small block map). */
export function latticeTriadSet(block: string, enc: LatticeBlock): TriadSet {
  const features: TriadFeature[] = [];
  const idByName = new Map<string, number>();
  for (const [key, ring] of latticeTriangles(enc)) {
    const [h, t] = key.split(":").map(Number);
    const name = triadName(block, h, t);
    idByName.set(name, features.length);
    features.push({
      type: "Feature",
      id: features.length,
      properties: { name, block, hexa: h, t },
      geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] },
    });
  }
  for (const [name, delta] of enc.x ?? []) {
    const ring: [number, number][] = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i + 1 < delta.length; i += 2) {
      x += delta[i];
      y += delta[i + 1];
      ring.push([x / 1e7, y / 1e7]);
    }
    idByName.set(name, features.length);
    features.push({ type: "Feature", id: features.length, properties: { name, block, hexa: null, t: null }, geometry: { type: "Polygon", coordinates: [ring] } });
  }
  return { fc: { type: "FeatureCollection", features }, idByName, count: features.length };
}

/* ---------- the farm: an index, then every block's lattice ---------- */

/** A farm with more triangles than this shows triangles only from BIG_TRI_ZOOM (field-layers);
 *  every block is loaded either way. */
export const FULL_LOAD_MAX_TRIADS = 20_000;
/** Blocks per request, by triangle count (a request is ~1/5 of Endebess at this size). */
export const CHUNK_TRIADS = 60_000;

export interface FieldIndex {
  version: string;
  /** block -> [triads, hexas] */
  counts: Record<string, [number, number]>;
  triads: number;
  hexas: number;
}

const INDEX_METHOD = "upande_scp.serverscripts.geo.field_geo.get_field_index";
const LATTICE_METHOD = "upande_scp.serverscripts.geo.field_lattice.get_field_lattice";
const IDB_MAX_AGE = 14 * 24 * 60 * 60 * 1000;
const LATTICE_IDB_VERSION = 1;
const indexMemory = new Map<string, Promise<FieldIndex>>();

export function fetchFieldIndex(farm = ""): Promise<FieldIndex> {
  let hit = indexMemory.get(farm);
  if (!hit) {
    hit = call<FieldIndex>(INDEX_METHOD, { farm: farm || undefined })
      .then((r) => ({
        version: r?.version ?? "",
        counts: r?.counts ?? {},
        triads: r?.triads ?? 0,
        hexas: r?.hexas ?? 0,
      }))
      .catch((e) => {
        indexMemory.delete(farm);
        throw e;
      });
    indexMemory.set(farm, hit);
  }
  return hit;
}

export function resetFieldIndexCache(): void {
  indexMemory.clear();
}

export class StaleFieldIndex extends Error {
  constructor() {
    super("field geometry changed; reload the index");
  }
}

const EMPTY_BLOCK: LatticeBlock = { h: [], e: [], x: [] };

/** One-off: the lattice of a few blocks (no local copy), e.g. a photo's block in the gallery. */
export async function fetchLatticeBlocks(blocks: string[], farm = ""): Promise<Record<string, LatticeBlock>> {
  const r = await call<{ blocks?: Record<string, LatticeBlock> }>(LATTICE_METHOD, {
    blocks: JSON.stringify(blocks),
    farm: farm || undefined,
  });
  return r?.blocks ?? {};
}

/** Blocks at ``version``: from the local copy (IndexedDB, per block) when it has them, else the
 *  server; what the server sends is kept locally for the next visit. */
export async function loadLatticeBlocks(farm: string, version: string, blocks: string[]): Promise<Map<string, LatticeBlock>> {
  const out = new Map<string, LatticeBlock>();
  const fromNet: string[] = [];
  await Promise.all(
    blocks.map(async (b) => {
      try {
        const held = await getPayload<{ version: string; enc: LatticeBlock }>(`field_lat:${farm}:${b}`, LATTICE_IDB_VERSION, IDB_MAX_AGE);
        if (held && held.version === version && held.enc) out.set(b, held.enc);
        else fromNet.push(b);
      } catch {
        fromNet.push(b);
      }
    }),
  );
  if (fromNet.length) {
    const r = await call<{ stale?: boolean; blocks?: Record<string, LatticeBlock> }>(LATTICE_METHOD, {
      blocks: JSON.stringify(fromNet),
      version,
      farm: farm || undefined,
    });
    if (r?.stale) throw new StaleFieldIndex();
    for (const b of fromNet) {
      const enc = r?.blocks?.[b] ?? EMPTY_BLOCK;
      out.set(b, enc);
      setPayload(`field_lat:${farm}:${b}`, { version, enc }, LATTICE_IDB_VERSION).catch(() => undefined);
    }
  }
  return out;
}

/** Split blocks into chunks of at most ``max`` triangles (a bigger block is a chunk of its own),
 *  keeping the given order. Pure. */
export function chunkBlocks(blocks: string[], counts: Record<string, [number, number]>, max = CHUNK_TRIADS): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let n = 0;
  for (const b of blocks) {
    const c = counts[b]?.[0] ?? 0;
    if (cur.length && n + c > max) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(b);
    n += c;
  }
  if (cur.length) out.push(cur);
  return out;
}

/* ---------- the farm in memory: where each triad is drawn ---------- */

export type TriadSlot = { kind: "inst"; held: HeldLattice; i: number } | { kind: "clip"; source: string; id: number };

export interface HeldLattice {
  name: string;
  enc: LatticeBlock;
  cells: LatticeCells;
  /** instance index of (cell, t) for full triangles: cell * 8 + t -> instance */
  inst: Map<number, number>;
  /** clipped / off-lattice pieces: cell * 8 + t (or the own name) -> feature id */
  clip: Map<number | string, number>;
  clipSource: string;
  /** cell index by hexa number */
  byNo: Map<number, number>;
  /** lng/lat box */
  box: [number, number, number, number];
}

const NAME_RE = /^(.*) - Hexa (\d+) - Triad (\d+)$/;

/**
 * The whole farm's lattice, held compactly: each full triangle is an instance (block, index) in
 * the GPU layer, each clipped piece a feature id in a small GeoJSON source. A triad name resolves
 * to its place without any per-triangle name map.
 */
export class FarmLattice {
  readonly blocks: HeldLattice[] = [];
  private byName = new Map<string, number>();
  private nextClip = 0;

  get size(): number {
    return this.blocks.length;
  }

  /** Add a block; ``clipSource`` is the GeoJSON source its edge pieces go to. */
  add(name: string, enc: LatticeBlock, clipSource: string): HeldLattice {
    const cells = latticeCells(enc);
    const inst = new Map<number, number>();
    const clip = new Map<number | string, number>();
    const byNo = new Map<number, number>();
    let k = 0;
    for (let i = 0; i < cells.n; i++) {
      byNo.set(cells.no[i], i);
      for (let t = 1; t <= 6; t++) if ((cells.full[i] >> (t - 1)) & 1) inst.set(i * 8 + t, k++);
    }
    for (const [i, t] of enc.e) clip.set(i * 8 + t, this.nextClip++);
    for (const [own] of enc.x ?? []) clip.set(own, this.nextClip++);
    let box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    if (enc.aff && cells.n) {
      const side = enc.side ?? 5;
      for (let i = 0; i < cells.n; i++) {
        const [lng, lat] = latticeToLngLat(enc, cells.x[i], cells.y[i]);
        const pad = (side / 111320) * 1.2;
        box = [Math.min(box[0], lng - pad), Math.min(box[1], lat - pad), Math.max(box[2], lng + pad), Math.max(box[3], lat + pad)];
      }
    }
    const held: HeldLattice = { name, enc, cells, inst, clip, clipSource, byNo, box };
    this.byName.set(name, this.blocks.length);
    this.blocks.push(held);
    return held;
  }

  /** Where a triad is drawn, or null if its block is not loaded / it has no such triangle. */
  lookup(name: string): TriadSlot | null {
    const m = NAME_RE.exec(name);
    if (m) {
      const bi = this.byName.get(m[1]);
      if (bi !== undefined) {
        const b = this.blocks[bi];
        const cell = b.byNo.get(Number(m[2]));
        if (cell !== undefined) {
          const key = cell * 8 + Number(m[3]);
          const i = b.inst.get(key);
          if (i !== undefined) return { kind: "inst", held: b, i };
          const id = b.clip.get(key);
          if (id !== undefined) return { kind: "clip", source: b.clipSource, id };
        }
      }
    }
    for (const b of this.blocks) {
      const id = b.clip.get(name);
      if (id !== undefined) return { kind: "clip", source: b.clipSource, id };
    }
    return null;
  }

  /** [lng, lat] of a triad's middle (hexa centre + its triangle's centroid, or the piece's ring
   *  mean), or null when its block / piece is not loaded. Used to place stations and spheres. */
  centroid(name: string): [number, number] | null {
    const m = NAME_RE.exec(name);
    if (m) {
      const b = this.blocks[this.byName.get(m[1]) ?? -1];
      const cell = b?.byNo.get(Number(m[2]));
      if (b && cell !== undefined && b.enc.aff) {
        const t = Number(m[3]);
        const { cells, enc } = b;
        if ((cells.full[cell] >> (t - 1)) & 1) {
          const side = enc.side ?? 5;
          const [ax, ay] = slotCorner(side, t, 1);
          const [bx, by] = slotCorner(side, t, 2);
          return latticeToLngLat(enc, cells.x[cell] + (ax + bx) / 3, cells.y[cell] + (ay + by) / 3);
        }
        for (const [i, tt, ring] of enc.e) {
          if (i !== cell || tt !== t) continue;
          let sx = 0;
          let sy = 0;
          const n = ring.length / 2;
          for (let j = 0; j + 1 < ring.length; j += 2) (sx += ring[j] / 100), (sy += ring[j + 1] / 100);
          return n ? latticeToLngLat(enc, cells.x[cell] + sx / n, cells.y[cell] + sy / n) : null;
        }
      }
    }
    for (const b of this.blocks)
      for (const [own, delta] of b.enc.x ?? []) {
        if (own !== name) continue;
        let x = 0;
        let y = 0;
        let sx = 0;
        let sy = 0;
        const n = delta.length / 2;
        for (let j = 0; j + 1 < delta.length; j += 2) {
          x += delta[j];
          y += delta[j + 1];
          sx += x;
          sy += y;
        }
        return n ? [sx / n / 1e7, sy / n / 1e7] : null;
      }
    return null;
  }

  /** The triad under a point (lng/lat), by lattice maths; null off the farm's triangles. */
  pick(lng: number, lat: number, block?: string): string | null {
    for (const b of this.blocks) {
      if (block && b.name !== block) continue;
      if (lng < b.box[0] || lng > b.box[2] || lat < b.box[1] || lat > b.box[3]) continue;
      const hit = latticePick(b.enc, b.cells, lng, lat);
      if (hit) return triadName(b.name, hit.no, hit.t);
    }
    return null;
  }
}

const fmt = (v: number) => v.toFixed(7);

/** The edge (clipped) and off-lattice pieces of some held blocks as GeoJSON text, with the
 *  feature ids FarmLattice gave them. Pure. */
export function edgePiecesGeojsonText(blocks: HeldLattice[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    const { enc, cells } = b;
    for (const [i, t, ring] of enc.e) {
      const pts: string[] = [];
      for (let j = 0; j + 1 < ring.length; j += 2) {
        const [lng, lat] = latticeToLngLat(enc, cells.x[i] + ring[j] / 100, cells.y[i] + ring[j + 1] / 100);
        pts.push(`[${fmt(lng)},${fmt(lat)}]`);
      }
      pts.push(pts[0]);
      out.push(`{"type":"Feature","id":${b.clip.get(i * 8 + t)},"properties":{},"geometry":{"type":"Polygon","coordinates":[[${pts.join(",")}]]}}`);
    }
    for (const [own, delta] of enc.x ?? []) {
      const pts: string[] = [];
      let x = 0;
      let y = 0;
      for (let j = 0; j + 1 < delta.length; j += 2) {
        x += delta[j];
        y += delta[j + 1];
        pts.push(`[${fmt(x / 1e7)},${fmt(y / 1e7)}]`);
      }
      out.push(`{"type":"Feature","id":${b.clip.get(own)},"properties":{},"geometry":{"type":"Polygon","coordinates":[[${pts.join(",")}]]}}`);
    }
  }
  return `{"type":"FeatureCollection","features":[${out.join(",")}]}`;
}

/* ---------- small geometry helpers ---------- */

export type BBox = [number, number, number, number]; // minX, minY, maxX, maxY

/** Bounding box of every polygon ring of a block feature. */
export function geometryBBox(g: { type?: string; coordinates?: unknown } | null | undefined): BBox | null {
  if (!g || !Array.isArray(g.coordinates)) return null;
  const rings: number[][][] =
    g.type === "Polygon" ? (g.coordinates as number[][][]) : g.type === "MultiPolygon" ? (g.coordinates as number[][][][]).flat() : [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings)
    for (const c of r) {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/** Slippy-map tiles covering ``box`` at zoom ``z``. Pure. */
export function tilesForBox(box: BBox, z: number): Array<[number, number]> {
  const n = 2 ** z;
  const tx = (lng: number) => Math.floor(((lng + 180) / 360) * n);
  const ty = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };
  const out: Array<[number, number]> = [];
  for (let x = tx(box[0]); x <= tx(box[2]); x++) for (let y = ty(box[3]); y <= ty(box[1]); y++) out.push([x, y]);
  return out;
}

