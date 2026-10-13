/**
 * Inverse-distance-weighted fill for the outdoor pest heatmap.
 *
 * Pure functions, no DOM: a grid clipped to block polygons (Polygon and
 * MultiPolygon), a bucket index over the samples, and the IDW itself (k nearest
 * within a radius, power 2) that also reports the distance to the nearest sample
 * so the renderer can fade estimates against measurements.
 * Spec: docs/superpowers/specs/2026-10-13-outdoor-pest-heatmap-and-block-groups-design.md
 */

export type Ring = Array<[number, number]>; // lng, lat
export interface Poly {
  /** caller's tag (e.g. block name); carried onto grid cells */
  tag: string;
  outer: Ring;
  holes: Ring[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
/** A sample in metres in the grid's local frame. */
export interface Sample {
  x: number;
  y: number;
  v: number;
}

const M_PER_DEG_LAT = 111_320;

export interface Frame {
  lng0: number;
  lat0: number;
  mx: number; // metres per degree lng
  my: number;
}
export function makeFrame(lng0: number, lat0: number): Frame {
  return { lng0, lat0, mx: M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180), my: M_PER_DEG_LAT };
}
export const toXY = (f: Frame, lng: number, lat: number): [number, number] => [
  (lng - f.lng0) * f.mx,
  (lat - f.lat0) * f.my,
];

function ringBounds(r: Ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of r) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Flatten a GeoJSON FeatureCollection (Polygon + MultiPolygon) into `Poly`s.
 *  `tagOf` names each feature; every member of a MultiPolygon shares the tag. */
export function polysFromGeojson(
  fc: { features: Array<{ geometry: any; properties?: any }> },
  tagOf: (props: any) => string = () => "",
): Poly[] {
  const out: Poly[] = [];
  const push = (rings: any[], tag: string) => {
    if (!rings?.length || !rings[0]?.length) return;
    out.push({ tag, outer: rings[0], holes: rings.slice(1), ...ringBounds(rings[0]) });
  };
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    const tag = tagOf(f.properties || {});
    if (g.type === "Polygon") push(g.coordinates, tag);
    else if (g.type === "MultiPolygon") for (const p of g.coordinates) push(p, tag);
  }
  return out;
}

function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function inPoly(x: number, y: number, p: Poly): boolean {
  if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) return false;
  if (!inRing(x, y, p.outer)) return false;
  for (const h of p.holes) if (inRing(x, y, h)) return false;
  return true;
}

/** Keep polygons whose bbox, grown by `r` degrees-metres, holds a sample. */
export function polysNear(polys: Poly[], samples: Array<{ lng: number; lat: number }>, rM: number, f: Frame): Poly[] {
  const dx = rM / f.mx;
  const dy = rM / f.my;
  return polys.filter((p) =>
    samples.some(
      (s) => s.lng >= p.minX - dx && s.lng <= p.maxX + dx && s.lat >= p.minY - dy && s.lat <= p.maxY + dy,
    ),
  );
}

export interface Grid {
  cols: number;
  rows: number;
  cellM: number;
  frame: Frame;
  /** bbox in lng/lat (west, south, east, north) — the image source corners */
  west: number;
  south: number;
  east: number;
  north: number;
  /** per cell (row 0 = north): index into `tags`, or -1 outside every polygon */
  owner: Int16Array;
  tags: string[];
}

/** Lay a grid over the polygons (~`cellM` metres, coarsened until it holds at
 *  most `maxCells` cells) and mark which cells fall inside a polygon. */
export function buildGrid(polys: Poly[], frame: Frame, cellM = 10, maxCells = 40_000): Grid | null {
  if (!polys.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polys) {
    minX = Math.min(minX, p.minX);
    minY = Math.min(minY, p.minY);
    maxX = Math.max(maxX, p.maxX);
    maxY = Math.max(maxY, p.maxY);
  }
  const wM = (maxX - minX) * frame.mx;
  const hM = (maxY - minY) * frame.my;
  if (!(wM > 0 && hM > 0)) return null;
  let cell = cellM;
  while ((wM / cell) * (hM / cell) > maxCells) cell *= 1.25;
  const cols = Math.max(1, Math.ceil(wM / cell - 1e-6));
  const rows = Math.max(1, Math.ceil(hM / cell - 1e-6));
  // grid spans exactly cols*cell by rows*cell from the west/north edge
  const east = minX + (cols * cell) / frame.mx;
  const south = maxY - (rows * cell) / frame.my;
  const tags: string[] = [];
  const tagIdx = new Map<string, number>();
  const polyTag = polys.map((p) => {
    let i = tagIdx.get(p.tag);
    if (i == null) {
      i = tags.length;
      tags.push(p.tag);
      tagIdx.set(p.tag, i);
    }
    return i;
  });
  const owner = new Int16Array(cols * rows).fill(-1);
  const dx = cell / frame.mx;
  const dy = cell / frame.my;
  for (let pi = 0; pi < polys.length; pi++) {
    const p = polys[pi];
    const c0 = Math.max(0, Math.floor((p.minX - minX) / dx));
    const c1 = Math.min(cols - 1, Math.floor((p.maxX - minX) / dx));
    const r0 = Math.max(0, Math.floor((maxY - p.maxY) / dy));
    const r1 = Math.min(rows - 1, Math.floor((maxY - p.minY) / dy));
    for (let r = r0; r <= r1; r++) {
      const y = maxY - (r + 0.5) * dy;
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c;
        if (owner[i] !== -1) continue;
        if (inPoly(minX + (c + 0.5) * dx, y, p)) owner[i] = polyTag[pi];
      }
    }
  }
  return { cols, rows, cellM: cell, frame, west: minX, south, east, north: maxY, owner, tags };
}

/** Bucket grid over samples (CSR layout: one typed array, no per-query Map). */
export class BucketIndex {
  private cols: number;
  private rows: number;
  private minCx: number;
  private minCy: number;
  private start: Int32Array;
  private items: Int32Array;
  constructor(private samples: Sample[], private size: number) {
    let minCx = Infinity, minCy = Infinity, maxCx = -Infinity, maxCy = -Infinity;
    for (const s of samples) {
      const cx = Math.floor(s.x / size), cy = Math.floor(s.y / size);
      if (cx < minCx) minCx = cx;
      if (cx > maxCx) maxCx = cx;
      if (cy < minCy) minCy = cy;
      if (cy > maxCy) maxCy = cy;
    }
    if (!samples.length) { minCx = minCy = 0; maxCx = maxCy = -1; }
    this.minCx = minCx;
    this.minCy = minCy;
    this.cols = maxCx - minCx + 1;
    this.rows = maxCy - minCy + 1;
    const counts = new Int32Array(this.cols * this.rows + 1);
    const cell = samples.map((s) => (Math.floor(s.y / size) - minCy) * this.cols + (Math.floor(s.x / size) - minCx));
    for (const c of cell) counts[c + 1]++;
    for (let i = 0; i < this.cols * this.rows; i++) counts[i + 1] += counts[i];
    this.start = counts.slice();
    this.items = new Int32Array(samples.length);
    const fill = counts.slice(0, this.cols * this.rows);
    cell.forEach((c, i) => { this.items[fill[c]++] = i; });
  }
  /** The k nearest samples within `r`, by expanding rings of buckets and
   *  stopping as soon as the k-th is closer than the ring just scanned.
   *  Fills `d2s` (squared distance, ascending) and `vs`; returns the count. */
  nearestK(x: number, y: number, k: number, r: number, d2s: Float64Array, vs: Float64Array): number {
    const cx = Math.floor(x / this.size) - this.minCx, cy = Math.floor(y / this.size) - this.minCy;
    const maxN = Math.ceil(r / this.size);
    const r2 = r * r;
    let m = 0;
    for (let n = 0; n <= maxN; n++) {
      const j0 = cy - n, j1 = cy + n, i0 = cx - n, i1 = cx + n;
      for (let j = Math.max(0, j0); j <= Math.min(this.rows - 1, j1); j++) {
        const edgeRow = j === j0 || j === j1;
        for (let i = Math.max(0, i0); i <= Math.min(this.cols - 1, i1); i++) {
          if (!edgeRow && i !== i0 && i !== i1) continue;
          const b = j * this.cols + i;
          for (let q = this.start[b]; q < this.start[b + 1]; q++) {
            const sm = this.samples[this.items[q]];
            const dx = sm.x - x, dy = sm.y - y;
            const d2 = dx * dx + dy * dy;
            if (d2 > r2 || (m === k && d2 >= d2s[k - 1])) continue;
            let p = m < k ? m : k - 1;
            while (p > 0 && d2s[p - 1] > d2) {
              d2s[p] = d2s[p - 1];
              vs[p] = vs[p - 1];
              p--;
            }
            d2s[p] = d2;
            vs[p] = sm.v;
            if (m < k) m++;
          }
        }
      }
      // everything within n*size of the query has been scanned
      if (m === k && d2s[k - 1] <= n * this.size * (n * this.size)) break;
    }
    return m;
  }
  /** indices of samples within `r` of (x, y) */
  within(x: number, y: number, r: number, out: number[] = []): number[] {
    out.length = 0;
    const cx = Math.floor(x / this.size) - this.minCx, cy = Math.floor(y / this.size) - this.minCy;
    const n = Math.ceil(r / this.size);
    const r2 = r * r;
    const c0 = Math.max(0, cx - n), c1 = Math.min(this.cols - 1, cx + n);
    const y0 = Math.max(0, cy - n), y1 = Math.min(this.rows - 1, cy + n);
    for (let j = y0; j <= y1; j++)
      for (let i = c0; i <= c1; i++) {
        const b = j * this.cols + i;
        for (let q = this.start[b]; q < this.start[b + 1]; q++) {
          const s = this.items[q];
          const dx = this.samples[s].x - x, dy = this.samples[s].y - y;
          if (dx * dx + dy * dy <= r2) out.push(s);
        }
      }
    return out;
  }
}

export interface IdwOpts {
  k?: number;
  power?: number;
  radiusM?: number;
}
export interface Field {
  /** NaN where no sample lies within the radius (or the cell is outside) */
  value: Float32Array;
  /** distance to the nearest sample (m); Infinity when unfilled */
  dist: Float32Array;
}

/** Inverse-distance-weighted mean of the k nearest samples within the radius,
 *  per inside cell. Zeros are real samples. */
export function idwField(grid: Grid, samples: Sample[], opts: IdwOpts = {}): Field {
  const k = opts.k ?? 8, power = opts.power ?? 2, R = opts.radiusM ?? 120;
  const n = grid.cols * grid.rows;
  const value = new Float32Array(n).fill(NaN);
  const dist = new Float32Array(n).fill(Infinity);
  if (!samples.length) return { value, dist };
  const idx = new BucketIndex(samples, R / 4);
  const d2s = new Float64Array(k), vs = new Float64Array(k);
  for (let r = 0; r < grid.rows; r++) {
    const y = (grid.north - grid.south) * grid.frame.my - (r + 0.5) * grid.cellM; // metres up from south
    for (let c = 0; c < grid.cols; c++) {
      const i = r * grid.cols + c;
      if (grid.owner[i] < 0) continue;
      const x = (c + 0.5) * grid.cellM;
      const m = idx.nearestK(x, y, k, R, d2s, vs);
      if (!m) continue;
      let num = 0, den = 0;
      if (d2s[0] < 1e-6) {
        value[i] = vs[0];
      } else {
        for (let j = 0; j < m; j++) {
          const w = 1 / Math.pow(d2s[j], power / 2);
          num += w * vs[j];
          den += w;
        }
        value[i] = num / den;
      }
      dist[i] = Math.sqrt(d2s[0]);
    }
  }
  return { value, dist };
}

/** Sample coordinates into the grid's metre frame (origin = grid south-west). */
export function samplesToGrid(
  grid: Grid,
  pts: Array<{ lng: number; lat: number; v: number }>,
): Sample[] {
  return pts.map((p) => ({
    x: (p.lng - grid.west) * grid.frame.mx,
    y: (p.lat - grid.south) * grid.frame.my,
    v: p.v,
  }));
}

export interface Cuts {
  /** amber from here */
  mid: number;
  /** red from here */
  high: number;
}
/** Quantile fallback: thirds of the non-zero values (zero is always "none"). */
export function quantileCuts(values: number[]): Cuts {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!nz.length) return { mid: Infinity, high: Infinity };
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))];
  let mid = q(1 / 3), high = q(2 / 3);
  if (high <= mid) high = mid * 1.0001 + 1e-9; // few distinct values
  return { mid, high };
}

/** Default bands while a pest has no action threshold: the field value is the
 *  local mean finds per scouted tree, so amber from 1 in 5 trees and red from 1
 *  in 2. Fixed, not relative: a widespread pest should read red everywhere, and a
 *  rare one green — thirds of the values would paint a third red either way. */
export const DEFAULT_CUTS: Cuts = { mid: 0.2, high: 0.5 };

/** 0 green, 1 amber, 2 red. A value at/over a cut is in that band. */
export function classOf(v: number, c: Cuts): 0 | 1 | 2 {
  return v >= c.high ? 2 : v >= c.mid ? 1 : 0;
}

/** Per-owner mean value and share of filled area in red. */
export function summarizeByOwner(grid: Grid, field: Field, cuts: Cuts) {
  const sum = new Float64Array(grid.tags.length), red = new Int32Array(grid.tags.length), cnt = new Int32Array(grid.tags.length);
  const total = new Int32Array(grid.tags.length);
  for (let i = 0; i < grid.owner.length; i++) {
    const o = grid.owner[i];
    if (o < 0) continue;
    total[o]++;
    const v = field.value[i];
    if (Number.isNaN(v)) continue;
    cnt[o]++;
    sum[o] += v;
    if (classOf(v, cuts) === 2) red[o]++;
  }
  return grid.tags.map((tag, o) => ({
    tag,
    mean: cnt[o] ? sum[o] / cnt[o] : 0,
    redShare: cnt[o] ? red[o] / cnt[o] : 0,
    coverage: total[o] ? cnt[o] / total[o] : 0,
  }));
}

/** RGBA pixels (row 0 north). Estimated cells fade with distance to the nearest
 *  sample; cells with nothing within reach get a faint hatch. */
export function renderRgba(
  grid: Grid,
  field: Field,
  cuts: Cuts,
  colors: [string, string, string],
  radiusM = 120,
): Uint8ClampedArray {
  const rgb = colors.map((h) => [1, 3, 5].map((o) => parseInt(h.slice(o, o + 2), 16)));
  const out = new Uint8ClampedArray(grid.cols * grid.rows * 4);
  for (let r = 0; r < grid.rows; r++)
    for (let c = 0; c < grid.cols; c++) {
      const i = r * grid.cols + c;
      if (grid.owner[i] < 0) continue;
      const v = field.value[i];
      const o = i * 4;
      if (Number.isNaN(v)) {
        if ((r + c) % 3 === 0) {
          out[o] = 90; out[o + 1] = 90; out[o + 2] = 84; out[o + 3] = 70;
        }
        continue;
      }
      const col = rgb[classOf(v, cuts)];
      const t = Math.min(1, field.dist[i] / radiusM);
      out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2];
      out[o + 3] = Math.round(255 * (0.8 - 0.55 * t));
    }
  return out;
}
