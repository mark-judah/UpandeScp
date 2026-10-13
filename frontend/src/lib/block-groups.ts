/**
 * Joining blocks for one outdoor spray run: selected blocks whose polygons are
 * within a tolerance of each other (edge to edge) form one group; selections that
 * do not touch stay separate runs. Pure geometry — union-find over pairwise
 * polygon distance in a local metric projection. No heavy deps.
 */

type Pt = [number, number];
type Ring = Pt[];
/** A polygon = outer ring + holes; only the outer ring matters for distance. */
type Poly = Ring[];

interface FeatureLike {
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, any> | null;
}

/** A block's name on a blocks-geojson feature (same match the page uses). */
export const featureTag = (f: FeatureLike): string => {
  const p = f.properties || {};
  return p.block || p.block_label || p.name || "";
};

function polygonsOf(f: FeatureLike): Poly[] {
  const g = f.geometry;
  if (!g) return [];
  if (g.type === "Polygon") return [g.coordinates as Poly];
  if (g.type === "MultiPolygon") return g.coordinates as Poly[];
  return [];
}

const M_PER_DEG_LAT = 111_320;

function project(ring: Ring, lat0: number): Ring {
  const kx = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return ring.map(([lng, lat]) => [lng * kx, lat * M_PER_DEG_LAT] as Pt);
}

function ptSegDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function segsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Distance between two segments: 0 when they cross, else the nearest endpoint pair. */
export function segmentDistance(a: Pt, b: Pt, c: Pt, d: Pt): number {
  if (segsCross(a, b, c, d)) return 0;
  return Math.min(ptSegDist(a, c, d), ptSegDist(b, c, d), ptSegDist(c, a, b), ptSegDist(d, a, b));
}

function inRing(p: Pt, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

interface Prepared {
  ring: Ring;
  box: [number, number, number, number];
}

function prepare(f: FeatureLike, lat0: number): Prepared[] {
  return polygonsOf(f)
    .map((poly) => poly?.[0])
    .filter((r): r is Ring => !!r && r.length >= 3)
    .map((r) => {
      const ring = project(r, lat0);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of ring) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      return { ring, box: [x0, y0, x1, y1] as [number, number, number, number] };
    });
}

/** True if any two rings are within `tol` metres (touching, overlapping or nested count). */
function within(A: Prepared[], B: Prepared[], tol: number): boolean {
  for (const a of A) {
    for (const b of B) {
      if (
        a.box[0] - tol > b.box[2] || b.box[0] - tol > a.box[2] ||
        a.box[1] - tol > b.box[3] || b.box[1] - tol > a.box[3]
      )
        continue;
      if (inRing(a.ring[0], b.ring) || inRing(b.ring[0], a.ring)) return true;
      for (let i = 0; i < a.ring.length - 1; i++)
        for (let j = 0; j < b.ring.length - 1; j++)
          if (segmentDistance(a.ring[i], a.ring[i + 1], b.ring[j], b.ring[j + 1]) <= tol) return true;
    }
  }
  return false;
}

/**
 * Group the `selected` block names by adjacency (edge-to-edge gap <= toleranceM,
 * chains join: A-B-C is one group when A~B and B~C). A selected name with no
 * polygon is its own group. Groups keep the order blocks were selected in.
 */
export function groupAdjacentBlocks(
  features: FeatureLike[],
  selected: string[],
  toleranceM: number,
): string[][] {
  const names = Array.from(new Set(selected));
  const byTag = new Map<string, FeatureLike>();
  for (const f of features) {
    const t = featureTag(f);
    if (t && !byTag.has(t)) byTag.set(t, f);
  }
  let lat0 = 0;
  let n = 0;
  for (const nm of names)
    for (const poly of polygonsOf(byTag.get(nm) || {})) {
      const c = poly?.[0]?.[0];
      if (c) {
        lat0 += c[1];
        n++;
      }
    }
  lat0 = n ? lat0 / n : 0;
  const prepped = names.map((nm) => (byTag.has(nm) ? prepare(byTag.get(nm)!, lat0) : []));

  const parent = names.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++) {
      if (find(i) === find(j)) continue;
      if (prepped[i].length && prepped[j].length && within(prepped[i], prepped[j], toleranceM))
        parent[find(j)] = find(i);
    }
  const groups = new Map<number, string[]>();
  names.forEach((nm, i) => {
    const r = find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(nm);
  });
  return Array.from(groups.values());
}

/** Area share of each block in a group (area / total); blocks without area get 0. */
export function areaShares(areas: Record<string, number | undefined>, blocks: string[]): Record<string, number> {
  const total = blocks.reduce((s, b) => s + (areas[b] || 0), 0);
  return Object.fromEntries(blocks.map((b) => [b, total > 0 ? (areas[b] || 0) / total : 0]));
}

/** The block with the largest area (first on ties / when none has an area). */
export function largestBlock(areas: Record<string, number | undefined>, blocks: string[]): string {
  return blocks.reduce((best, b) => ((areas[b] || 0) > (areas[best] || 0) ? b : best), blocks[0]);
}
