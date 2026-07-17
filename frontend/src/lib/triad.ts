/**
 * Triad tessellation (pure geometry, no deps) with two accelerations so a big
 * irregular AOI stays responsive at small side lengths:
 *
 *   1. Coarse-cell classification — a coarse grid over the AOI is pre-classified
 *      interior / outside / boundary. Fine hexes in an INTERIOR cell are emitted
 *      analytically with NO per-triad point-in-polygon; OUTSIDE cells are
 *      skipped whole; only BOUNDARY cells run PIP. ("The big block determines
 *      the rest.")
 *   2. Viewport + LOD — `tessellate` only builds hexes inside the requested
 *      bounds, and drops to a coarser level (whole hexes, then nothing) when the
 *      visible count would blow the budget, so you always render fast: fine
 *      triads zoomed in, bigger hex blocks zoomed out.
 *
 * ⚠️ Exploratory — boundary units are kept whole (centroid-inside), not clipped.
 */

const M_PER_DEG_LAT = 111320;

export type Ring = [number, number][]; // [lng, lat], not required closed

export interface LngLatBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

export interface TriadFeature {
  type: "Feature";
  geometry: { type: "Polygon"; coordinates: [number, number][][] };
  properties: { id: string; hex: number; tri: number; color: string };
}
export interface TriadFC {
  type: "FeatureCollection";
  features: TriadFeature[];
}

export type LOD = "triad" | "hex" | "none";
export interface TessellateResult {
  fc: TriadFC;
  level: LOD;
  hexCount: number;
  triadCount: number;
}

const HEX_PALETTE = [
  "#2BA6E0", "#E66BAA", "#8466C7", "#E9A23B", "#5BB45D",
  "#3D54B0", "#E63946", "#10b981", "#f97316", "#a855f7",
];

// ── low-level geometry (all in the lattice/rotated frame, metres) ──────────
function pipRot(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
function segSeg(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (d === 0) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}
function edgeCrossesRect(
  ring: [number, number][], x0: number, y0: number, x1: number, y1: number,
): boolean {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][0], ay = ring[j][1], bx = ring[i][0], by = ring[i][1];
    if (
      segSeg(ax, ay, bx, by, x0, y0, x1, y0) ||
      segSeg(ax, ay, bx, by, x1, y0, x1, y1) ||
      segSeg(ax, ay, bx, by, x1, y1, x0, y1) ||
      segSeg(ax, ay, bx, by, x0, y1, x0, y0)
    )
      return true;
  }
  return false;
}

// ── index: lattice frame + coarse classification, built once per (AOI,s,rot) ─
export interface TriadIndex {
  s: number;
  colStep: number;
  rowStep: number;
  angles: number[];
  ringRot: [number, number][];
  minX: number; maxX: number; minY: number; maxY: number;
  cellSize: number;
  ncols: number;
  cellState: Int8Array; // 0 outside, 1 boundary, 2 interior (row-major)
  toWgs: (x: number, y: number) => [number, number];
  toRot: (lng: number, lat: number) => [number, number];
}

export function buildTriadIndex(
  ring: Ring,
  sideLength: number,
  rotationDeg = 0,
): TriadIndex | null {
  if (!ring || ring.length < 3 || !(sideLength > 0)) return null;
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  const lon0 = (Math.min(...lons) + Math.max(...lons)) / 2;
  const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
  const mLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  const theta = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(theta), sin = Math.sin(theta);

  const toRot = (lng: number, lat: number): [number, number] => {
    const lx = (lng - lon0) * mLon, ly = (lat - lat0) * M_PER_DEG_LAT;
    return [lx * cos + ly * sin, -lx * sin + ly * cos];
  };
  const toWgs = (x: number, y: number): [number, number] => {
    const lx = x * cos - y * sin, ly = x * sin + y * cos;
    return [lon0 + lx / mLon, lat0 + ly / M_PER_DEG_LAT];
  };

  const ringRot = ring.map(([lng, lat]) => toRot(lng, lat));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of ringRot) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const s = sideLength;
  const colStep = Math.sqrt(3) * s;
  const rowStep = 1.5 * s;
  const angles = [0, 1, 2, 3, 4, 5].map((k) => ((30 + 60 * k) * Math.PI) / 180);

  // Coarse cells sized to hold a good few hexes; bounded so classification stays
  // cheap even for tiny side lengths.
  const cellSize = Math.max(colStep * 6, 60);
  const ncols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const nrows = Math.max(1, Math.ceil((maxY - minY) / cellSize));
  const cellState = new Int8Array(ncols * nrows);
  for (let j = 0; j < nrows; j++) {
    for (let i = 0; i < ncols; i++) {
      const x0 = minX + i * cellSize, x1 = x0 + cellSize;
      const y0 = minY + j * cellSize, y1 = y0 + cellSize;
      const corners: [number, number][] = [
        [x0, y0], [x1, y0], [x1, y1], [x0, y1], [(x0 + x1) / 2, (y0 + y1) / 2],
      ];
      let inCount = 0;
      for (const [cx, cy] of corners) if (pipRot(cx, cy, ringRot)) inCount++;
      const crosses = edgeCrossesRect(ringRot, x0, y0, x1, y1);
      cellState[j * ncols + i] =
        !crosses && inCount === corners.length ? 2 : !crosses && inCount === 0 ? 0 : 1;
    }
  }

  return { s, colStep, rowStep, angles, ringRot, minX, maxX, minY, maxY, cellSize, ncols, cellState, toWgs, toRot };
}

// ── row runs: the orchard-row analogue ─────────────────────────────────────
// A "row" is a horizontal hex-row band. Within it, hexes whose centre is inside
// the AOI form contiguous runs (a concave AOI yields several runs per row — the
// obstacle-row case). Each run is stored as endpoints + count and reconstructs
// its interior by stepping colStep; each hex → 6 triads analytically.
export interface RowRun {
  row: number;
  firstCol: number;
  lastCol: number;
  hexCount: number; // hexes in this run
  triadCount: number; // = hexCount * 6
  first: [number, number]; // lng,lat of first hex centre
  last: [number, number]; // lng,lat of last hex centre
}

export function deriveRows(idx: TriadIndex | null): RowRun[] {
  if (!idx) return [];
  const { colStep, rowStep, minX, maxX, minY, maxY, ringRot } = idx;
  const runs: RowRun[] = [];
  const jMax = Math.ceil((maxY - minY) / rowStep);
  for (let r = 0; r <= jMax; r++) {
    const y = minY + r * rowStep;
    const xOff = ((r % 2) + 2) % 2 === 1 ? colStep / 2 : 0;
    const cEnd = Math.ceil((maxX - xOff - minX) / colStep);
    let firstCol = -1;
    let firstCentre: [number, number] | null = null;
    let lastCol = -1;
    let lastCentre: [number, number] | null = null;
    let count = 0;
    const flush = () => {
      if (firstCol >= 0 && firstCentre && lastCentre) {
        runs.push({
          row: r,
          firstCol,
          lastCol,
          hexCount: count,
          triadCount: count * 6,
          first: firstCentre,
          last: lastCentre,
        });
      }
      firstCol = -1;
      firstCentre = null;
      count = 0;
    };
    for (let c = 0; c <= cEnd; c++) {
      const x = minX + xOff + c * colStep;
      if (x < minX || x > maxX) continue;
      if (pipRot(x, y, ringRot)) {
        if (firstCol < 0) {
          firstCol = c;
          firstCentre = idx.toWgs(x, y);
        }
        lastCol = c;
        lastCentre = idx.toWgs(x, y);
        count++;
      } else if (firstCol >= 0) {
        flush();
      }
    }
    flush();
  }
  return runs;
}

function cellStateAt(idx: TriadIndex, x: number, y: number): number {
  if (x < idx.minX || x > idx.maxX || y < idx.minY || y > idx.maxY) return 0;
  const i = Math.min(idx.ncols - 1, Math.floor((x - idx.minX) / idx.cellSize));
  const j = Math.floor((y - idx.minY) / idx.cellSize);
  const s = idx.cellState[j * idx.ncols + i];
  return s === undefined ? 1 : s;
}

export interface TessellateOptions {
  /** Only build hexes whose centre falls in these lng/lat bounds. */
  bounds?: LngLatBounds;
  /** Budget: at most this many features before dropping to a coarser LOD. */
  maxFeatures?: number;
  /** Never subdivide into triads — emit whole hexes only (or `none`). */
  hexOnly?: boolean;
}

/**
 * Build the visible tessellation from a prebuilt index. Chooses an LOD by how
 * many features the visible extent would produce: `triad` (6/hex) → `hex`
 * (1/hex, bigger blocks) → `none` (zoom in).
 */
export function tessellate(
  idx: TriadIndex | null,
  { bounds, maxFeatures = 12000, hexOnly = false }: TessellateOptions = {},
): TessellateResult {
  const empty: TessellateResult = {
    fc: { type: "FeatureCollection", features: [] },
    level: "none",
    hexCount: 0,
    triadCount: 0,
  };
  if (!idx) return empty;

  // Iteration window in the lattice frame = AOI bbox ∩ (rotated viewport bbox).
  let xLo = idx.minX, xHi = idx.maxX, yLo = idx.minY, yHi = idx.maxY;
  if (bounds) {
    const corners: [number, number][] = [
      idx.toRot(bounds.west, bounds.south),
      idx.toRot(bounds.east, bounds.south),
      idx.toRot(bounds.east, bounds.north),
      idx.toRot(bounds.west, bounds.north),
    ];
    const bx = corners.map((c) => c[0]), by = corners.map((c) => c[1]);
    xLo = Math.max(xLo, Math.min(...bx));
    xHi = Math.min(xHi, Math.max(...bx));
    yLo = Math.max(yLo, Math.min(...by));
    yHi = Math.min(yHi, Math.max(...by));
  }
  if (xHi <= xLo || yHi <= yLo) return empty;

  // Estimate visible hexes from the coarse classification (interior + boundary
  // cells only) so an irregular AOI isn't over-counted by its bounding box.
  const nrows = idx.cellState.length / idx.ncols;
  const ci0 = Math.max(0, Math.floor((xLo - idx.minX) / idx.cellSize));
  const ci1 = Math.min(idx.ncols - 1, Math.floor((xHi - idx.minX) / idx.cellSize));
  const cj0 = Math.max(0, Math.floor((yLo - idx.minY) / idx.cellSize));
  const cj1 = Math.min(nrows - 1, Math.floor((yHi - idx.minY) / idx.cellSize));
  let coveredArea = 0;
  for (let j = cj0; j <= cj1; j++)
    for (let i = ci0; i <= ci1; i++) {
      if (idx.cellState[j * idx.ncols + i] === 0) continue;
      const cx0 = Math.max(xLo, idx.minX + i * idx.cellSize);
      const cx1 = Math.min(xHi, idx.minX + (i + 1) * idx.cellSize);
      const cy0 = Math.max(yLo, idx.minY + j * idx.cellSize);
      const cy1 = Math.min(yHi, idx.minY + (j + 1) * idx.cellSize);
      if (cx1 > cx0 && cy1 > cy0) coveredArea += (cx1 - cx0) * (cy1 - cy0);
    }
  const estHexes = coveredArea / (idx.colStep * idx.rowStep);
  const level: LOD = hexOnly
    ? estHexes <= maxFeatures
      ? "hex"
      : "none"
    : estHexes * 6 <= maxFeatures
      ? "triad"
      : estHexes <= maxFeatures
        ? "hex"
        : "none";
  if (level === "none") return { ...empty, level, hexCount: Math.round(estHexes) };

  const features: TriadFeature[] = [];
  const { colStep, rowStep, angles, ringRot, s } = idx;
  let hex = 0;

  // Row index from the global lattice so the alternate-row offset is stable
  // regardless of the viewport.
  const rowStart = Math.floor((yHi - idx.minY) / rowStep) + 1;
  const rowEnd = Math.floor((yLo - idx.minY) / rowStep) - 1;
  for (let r = rowStart; r >= rowEnd; r--) {
    const y = idx.minY + r * rowStep;
    const xOff = ((r % 2) + 2) % 2 === 1 ? colStep / 2 : 0;
    const cStart = Math.floor((xLo - xOff - idx.minX) / colStep) - 1;
    const cEnd = Math.floor((xHi - xOff - idx.minX) / colStep) + 1;
    for (let cIdx = cStart; cIdx <= cEnd; cIdx++) {
      const x = idx.minX + xOff + cIdx * colStep;
      const state = cellStateAt(idx, x, y);
      if (state === 0) continue; // outside cell → skip
      const color = HEX_PALETTE[hex % HEX_PALETTE.length];
      const verts = angles.map(
        (a): [number, number] => [x + s * Math.cos(a), y + s * Math.sin(a)],
      );

      if (level === "hex") {
        // Coarse block: one polygon per hex.
        if (state === 1 && !pipRot(x, y, ringRot)) continue; // boundary → centre test
        const poly = verts.map((v) => idx.toWgs(v[0], v[1]));
        poly.push(poly[0]);
        hex++;
        features.push({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [poly] },
          properties: { id: `H${hex}`, hex, tri: 0, color: HEX_PALETTE[(hex - 1) % HEX_PALETTE.length] },
        });
        continue;
      }

      // Fine: 6 triads. Interior cell → no PIP; boundary cell → per-triad PIP.
      const kept: TriadFeature[] = [];
      for (let k = 0; k < 6; k++) {
        const a = verts[k], b = verts[(k + 1) % 6];
        if (state === 1) {
          const cx = (x + a[0] + b[0]) / 3, cy = (y + a[1] + b[1]) / 3;
          if (!pipRot(cx, cy, ringRot)) continue;
        }
        const poly: [number, number][] = [
          idx.toWgs(x, y), idx.toWgs(a[0], a[1]), idx.toWgs(b[0], b[1]),
        ];
        poly.push(poly[0]);
        kept.push({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [poly] },
          properties: { id: `H?-${k + 1}`, hex: 0, tri: k + 1, color },
        });
      }
      if (kept.length) {
        hex++;
        for (const f of kept) {
          f.properties.hex = hex;
          f.properties.id = `H${hex}-${f.properties.tri}`;
          f.properties.color = HEX_PALETTE[(hex - 1) % HEX_PALETTE.length];
        }
        features.push(...kept);
      }
    }
  }

  return {
    fc: { type: "FeatureCollection", features },
    level,
    hexCount: hex,
    triadCount: level === "triad" ? features.length : 0,
  };
}
