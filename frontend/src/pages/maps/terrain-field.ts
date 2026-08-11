/**
 * Height field for the 3D greenhouse terrain.
 *
 * Turns per-zone observation counts into a smooth continuous surface: peaks
 * where pressure is high, flowing into each other across the closely-packed
 * beds rather than standing as isolated columns.
 *
 * The central rule: **an unscouted zone must never dip.** Not scouted does not
 * mean not there. A trough asserts absence, which the data cannot support — and
 * it would be the same error as treating flat ground as "clean". Unmeasured
 * ground is instead interpolated from its scouted neighbourhood, which is the
 * best available estimate given pest pressure is spatially autocorrelated.
 *
 * This matters constantly, not occasionally: scouts walk odd beds one session
 * and even beds the next, so in any single session every other bed is unscouted.
 * Rendering those as holes would draw the greenhouse as a comb.
 *
 * Because interpolated ground would otherwise look as authoritative as measured
 * ground, every cell also carries a **confidence** in [0,1] — 1 where a real
 * observation landed, falling off with distance. The renderer desaturates by
 * confidence, so the honesty lives in colour and height means count and only
 * count.
 */

export interface ZonePoint {
  /** projected position, any consistent unit */
  x: number;
  y: number;
  /** observations counted in this zone; 0 is a real measured zero */
  value: number;
}

export interface HeightField {
  /** row-major, length cols*rows, in the same units as the input values */
  heights: Float32Array;
  /** row-major, length cols*rows, 1 = measured, → 0 far from any observation */
  confidence: Float32Array;
  cols: number;
  rows: number;
  /** world-space bounds the grid covers */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface FieldOptions {
  /** grid resolution along the longer axis (default 96) */
  resolution?: number;
  /** diffusion passes used to fill unmeasured cells (default 24) */
  fillPasses?: number;
  /** gaussian passes applied at the end (default 2) */
  smoothPasses?: number;
}

const DEFAULTS = { resolution: 96, fillPasses: 24, smoothPasses: 2 };

/** Grid dimensions that preserve the greenhouse's aspect ratio, so beds don't
 *  get squashed along one axis. */
function gridSize(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  resolution: number,
): { cols: number; rows: number } {
  const w = Math.max(maxX - minX, 1e-9);
  const h = Math.max(maxY - minY, 1e-9);
  if (w >= h) {
    return { cols: resolution, rows: Math.max(2, Math.round((resolution * h) / w)) };
  }
  return { cols: Math.max(2, Math.round((resolution * w) / h)), rows: resolution };
}

/** Confidence retained per pyramid level climbed to find support. A cell filled
 *  from one level up is a short extrapolation; one filled from five levels up is
 *  a guess about a large empty region and must look like one. */
const LEVEL_CONFIDENCE_DECAY = 0.55;

/**
 * Push-pull (pyramid) gap fill, in place.
 *
 * Push: repeatedly halve the grid, each coarse cell holding the weighted mean of
 * its four children — so however large a gap is, some level covers it.
 * Pull: walk back down; a cell with no support of its own takes the value from
 * the level above, blended by how much support it does have.
 *
 * Measured cells are never overwritten. Confidence records how far up the
 * pyramid a cell had to reach, which is what separates a short interpolation
 * between adjacent beds from a broad guess across an unvisited block.
 */
function fillByPyramid(
  heights: Float32Array,
  confidence: Float32Array,
  measured: Uint8Array,
  cols: number,
  rows: number,
): void {
  const levels: Array<{ v: Float32Array; w: Float32Array; c: number; r: number }> = [
    { v: Float32Array.from(heights), w: Float32Array.from(measured), c: cols, r: rows },
  ];

  // push
  while (levels[levels.length - 1].c > 1 || levels[levels.length - 1].r > 1) {
    const fine = levels[levels.length - 1];
    const c = Math.max(1, Math.ceil(fine.c / 2));
    const r = Math.max(1, Math.ceil(fine.r / 2));
    const v = new Float32Array(c * r);
    const w = new Float32Array(c * r);
    for (let y = 0; y < r; y++) {
      for (let x = 0; x < c; x++) {
        let acc = 0;
        let wt = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const fx = x * 2 + dx;
            const fy = y * 2 + dy;
            if (fx >= fine.c || fy >= fine.r) continue;
            const j = fy * fine.c + fx;
            acc += fine.v[j] * fine.w[j];
            wt += fine.w[j];
          }
        }
        const i = y * c + x;
        if (wt > 0) {
          v[i] = acc / wt;
          w[i] = Math.min(1, wt);
        }
      }
    }
    levels.push({ v, w, c, r });
  }

  // pull
  const conf: Float32Array[] = levels.map((l) => new Float32Array(l.c * l.r));
  const top = levels.length - 1;
  for (let i = 0; i < levels[top].w.length; i++) {
    conf[top][i] = levels[top].w[i] > 0 ? 1 : 0;
  }
  for (let li = levels.length - 2; li >= 0; li--) {
    const fine = levels[li];
    const coarse = levels[li + 1];
    for (let y = 0; y < fine.r; y++) {
      for (let x = 0; x < fine.c; x++) {
        const i = y * fine.c + x;
        const j = Math.min(coarse.r - 1, y >> 1) * coarse.c + Math.min(coarse.c - 1, x >> 1);
        const own = fine.w[i];
        if (own >= 1) {
          conf[li][i] = 1;
          continue;
        }
        // Blend own (partial) support with the coarser estimate.
        fine.v[i] = fine.v[i] * own + coarse.v[j] * (1 - own);
        fine.w[i] = Math.max(own, coarse.w[j] > 0 ? 1 : 0);
        conf[li][i] =
          own + (1 - own) * conf[li + 1][j] * LEVEL_CONFIDENCE_DECAY;
      }
    }
  }

  const base = levels[0];
  for (let i = 0; i < heights.length; i++) {
    if (!measured[i]) heights[i] = base.v[i];
    confidence[i] = measured[i] ? 1 : conf[0][i];
  }
}

/**
 * Build the height field.
 *
 * Three steps, matching the design:
 *   1. **sample** — rasterise measured zones into grid cells (mean per cell)
 *   2. **fill**   — diffuse into unmeasured cells, measured cells pinned, so a
 *                   gap between two peaks rises to meet them instead of dipping
 *   3. **smooth** — a light blur so the surface flows peak to peak
 *
 * Diffusion rather than per-cell inverse-distance search: it is O(cells×passes)
 * instead of O(cells×zones), which matters at the measured worst case of 4,914
 * zones, and it produces the same "rises between neighbours" result.
 */
export function buildHeightField(
  zones: ZonePoint[],
  opts: FieldOptions = {},
): HeightField {
  const resolution = opts.resolution ?? DEFAULTS.resolution;
  const fillPasses = opts.fillPasses ?? DEFAULTS.fillPasses;
  const smoothPasses = opts.smoothPasses ?? DEFAULTS.smoothPasses;

  if (!zones.length) {
    return {
      heights: new Float32Array(0),
      confidence: new Float32Array(0),
      cols: 0,
      rows: 0,
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const z of zones) {
    if (z.x < minX) minX = z.x;
    if (z.x > maxX) maxX = z.x;
    if (z.y < minY) minY = z.y;
    if (z.y > maxY) maxY = z.y;
  }

  const { cols, rows } = gridSize(minX, minY, maxX, maxY, resolution);
  const n = cols * rows;
  const sum = new Float64Array(n);
  const hits = new Float64Array(n);

  const spanX = Math.max(maxX - minX, 1e-9);
  const spanY = Math.max(maxY - minY, 1e-9);

  // 1. sample
  for (const z of zones) {
    const cx = Math.min(cols - 1, Math.max(0, Math.round(((z.x - minX) / spanX) * (cols - 1))));
    const cy = Math.min(rows - 1, Math.max(0, Math.round(((z.y - minY) / spanY) * (rows - 1))));
    const i = cy * cols + cx;
    sum[i] += z.value;
    hits[i] += 1;
  }

  const heights = new Float32Array(n);
  // measured[i] pins a cell during diffusion — a real observation is never
  // overwritten by its neighbours, however sparse the surroundings.
  const measured = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (hits[i] > 0) {
      heights[i] = sum[i] / hits[i];
      measured[i] = 1;
    }
  }

  // Confidence starts as the measured mask and is blurred alongside the fill,
  // so it decays with distance from real data at the same rate the estimate does.
  const confidence = new Float32Array(n);
  for (let i = 0; i < n; i++) confidence[i] = measured[i];

  // 2. fill — push-pull pyramid.
  //
  // NOT iterative diffusion: averaging a cell with unmeasured (zero) neighbours
  // decays the value geometrically with distance instead of converging to the
  // neighbourhood, so a gap 16 cells wide came out at 7e-7 rather than ~10 —
  // a trough, the exact thing this must never produce. A push-pull pyramid
  // converges in one pass up and one pass down, in O(cells).
  fillByPyramid(heights, confidence, measured, cols, rows);

  // 3. smooth — blur everything, measured cells included, so peaks flow into
  // one another instead of stepping at bed boundaries.
  let buf = new Float32Array(heights);
  for (let pass = 0; pass < smoothPasses; pass++) {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let acc = 0;
        let w = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const wt = dx === 0 && dy === 0 ? 4 : dx && dy ? 1 : 2;
            acc += heights[ny * cols + nx] * wt;
            w += wt;
          }
        }
        buf[y * cols + x] = acc / w;
      }
    }
    heights.set(buf);
  }

  for (let i = 0; i < n; i++) {
    confidence[i] = Math.min(1, Math.max(0, confidence[i]));
  }

  return { heights, confidence, cols, rows, minX, minY, maxX, maxY };
}

/** Largest height across every frame.
 *
 *  Normalising per week would make every week look equally bad and the morph
 *  would show nothing; a single scale across the range is what makes the
 *  playback readable. The legend has to state it, since adding a week can
 *  rescale the whole terrain. */
export function peakAcross(fields: HeightField[]): number {
  let max = 0;
  for (const f of fields) {
    for (let i = 0; i < f.heights.length; i++) {
      if (f.heights[i] > max) max = f.heights[i];
    }
  }
  return max;
}

export interface TerrainWeek {
  date: string;
  complete?: boolean;
  /** beds this week's sessions actually covered — the sample size */
  bedsScouted?: number;
  zonesScouted?: number;
}

/** Weeks the playback steps through — every week that has data.
 *
 *  Partial weeks are NOT dropped. A single session covers one bed parity, but
 *  the interpolation already carries the surface smoothly across the beds it
 *  didn't visit, so a half-scouted week renders as a coherent surface rather
 *  than a comb — there is no collapse to guard against. Excluding them threw
 *  away 101 of 229 greenhouse-weeks, i.e. most of the record.
 *
 *  What a partial week needs is its SAMPLE SIZE shown (`bedsScouted`) so the
 *  viewer can weigh it — not exclusion. */
export function playableWeeks<T extends TerrainWeek>(weeks: T[]): T[] {
  return weeks;
}

/** Timeline entries for every week in range. All weeks are playable now; the
 *  `playable` flag is retained so a future exclusion rule has a place to live,
 *  and `complete` still distinguishes a full two-pass week from a partial one
 *  for labelling purposes. */
export function timeline<T extends TerrainWeek>(
  weeks: T[],
): Array<{ week: T; playable: boolean; frame: number | null }> {
  // Frame indices must line up with playableWeeks(), which now returns every
  // week — so each week gets a consecutive frame and none is left null.
  return playableWeeks(weeks).map((week, frame) => ({
    week,
    playable: true,
    frame,
  }));
}

/* =============================================================
 * Weight-paint colour ramp
 * ============================================================= */

/** Blender's weight-paint gradient: blue (low) → cyan → green → yellow → red
 *  (high). Chosen because it is the mental model the request came with, and
 *  because a full-hue ramp separates adjacent levels far more legibly than a
 *  single-hue lightness ramp once the surface is translucent and overlapping
 *  itself — which is the whole point of the orthographic view.
 *
 *  Note this is deliberately NOT perceptually uniform (viridis/turbo would be).
 *  A rainbow ramp exaggerates the blue→cyan and green→yellow boundaries, so
 *  read magnitudes from the legend, not from apparent colour distance. */
const WEIGHT_STOPS: Array<[number, [number, number, number]]> = [
  [0.0, [0.0, 0.0, 1.0]], // blue
  [0.25, [0.0, 1.0, 1.0]], // cyan
  [0.5, [0.0, 1.0, 0.0]], // green
  [0.75, [1.0, 1.0, 0.0]], // yellow
  [1.0, [1.0, 0.0, 0.0]], // red
];

/** Colour for a normalised value in [0,1]. Values outside are clamped, so a
 *  rounding overshoot can't wrap the ramp back to blue at the top end. */
export function weightPaintColor(t: number): {
  r: number;
  g: number;
  b: number;
} {
  const x = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  for (let i = 0; i < WEIGHT_STOPS.length - 1; i++) {
    const [t0, c0] = WEIGHT_STOPS[i];
    const [t1, c1] = WEIGHT_STOPS[i + 1];
    if (x <= t1) {
      const f = t1 === t0 ? 0 : (x - t0) / (t1 - t0);
      return {
        r: c0[0] + (c1[0] - c0[0]) * f,
        g: c0[1] + (c1[1] - c0[1]) * f,
        b: c0[2] + (c1[2] - c0[2]) * f,
      };
    }
  }
  const last = WEIGHT_STOPS[WEIGHT_STOPS.length - 1][1];
  return { r: last[0], g: last[1], b: last[2] };
}

/** Legend stops for the on-screen ramp, as CSS rgb() strings. */
export function weightPaintLegend(
  steps = 24,
): Array<{ t: number; css: string }> {
  return Array.from({ length: steps }, (_, i) => {
    const t = i / (steps - 1);
    const c = weightPaintColor(t);
    const to255 = (v: number) => Math.round(v * 255);
    return { t, css: `rgb(${to255(c.r)},${to255(c.g)},${to255(c.b)})` };
  });
}

/* =============================================================
 * Bed × Zone lattice
 *
 * The field above is indexed by PROJECTED GEOMETRY, which is right for drawing
 * the greenhouse's true outline but useless for asking "which bed is this?" —
 * a projected axis has no bed numbers to label, and a hovered cell maps back to
 * a coordinate, not an identity.
 *
 * A greenhouse is a regular bed × zone lattice, so indexing the grid by bed
 * number and zone number instead loses nothing and gains everything the
 * comparative view needs: axes that read 1..90, a hovered cell that knows its
 * bed, and — as a bonus — odd/even scouting alternation becomes literally
 * alternating rows, which is the ideal case for the pyramid fill to smooth over.
 * ============================================================= */

export interface LatticeEntry {
  /** full zone name, e.g. "Torongo GH 07 - KR - Bed 51 - Zone 9" */
  name: string;
  value: number;
}

export interface Lattice extends HeightField {
  /** Bed identity. Read according to `identity`:
   *   "axis" → indexed by ROW    (bed-order layout; also labels the axis)
   *   "cell" → indexed by CELL   (ground layout; beds aren't axis-aligned) */
  bedNumbers: number[];
  /** Zone identity — "axis" → indexed by COLUMN, "cell" → indexed by CELL. */
  zoneNumbers: number[];
  /** How to index bedNumbers/zoneNumbers. Explicit rather than inferred from
   *  array length: the two layouts genuinely differ, and guessing from
   *  `length === rows` would silently break on a square greenhouse. */
  identity: "axis" | "cell";
  /** row-major, 1 where a real observation landed */
  measured: Uint8Array;
}

const BED_RE = /Bed\s+(\d+)/i;
const ZONE_RE = /Zone\s+(\d+)/i;

/** Bed and zone numbers out of a zone name, or null if either is absent.
 *  Matches the server's `bed_parity` / `bed_of_zone` parsing — the bed number
 *  comes from after "Bed ", never from the greenhouse's own digits. */
export function parseBedZone(
  name: string,
): { bed: number; zone: number } | null {
  const b = BED_RE.exec(name || "");
  const z = ZONE_RE.exec(name || "");
  if (!b || !z) return null;
  return { bed: Number(b[1]), zone: Number(z[1]) };
}

/**
 * Build the height field in bed × zone index space.
 *
 * Rows are beds in ascending numeric order, columns are zones likewise, so the
 * axes can be labelled with the real numbers. Gaps are filled and smoothed by
 * the same pyramid pass as `buildHeightField`, so an unvisited bed still rises
 * to meet its neighbours rather than cutting a trough.
 */
export function buildLattice(
  entries: LatticeEntry[],
  opts: FieldOptions = {},
): Lattice {
  const smoothPasses = opts.smoothPasses ?? DEFAULTS.smoothPasses;

  const parsed: Array<{ bed: number; zone: number; value: number }> = [];
  for (const e of entries) {
    const bz = parseBedZone(e.name);
    if (bz) parsed.push({ ...bz, value: e.value });
  }
  if (!parsed.length) {
    return {
      heights: new Float32Array(0),
      confidence: new Float32Array(0),
      measured: new Uint8Array(0),
      cols: 0,
      rows: 0,
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      bedNumbers: [],
      zoneNumbers: [],
      identity: "axis",
    };
  }

  // Contiguous 1..max axes rather than only the beds that happen to appear:
  // a bed with no observations this week is still part of the house, and the
  // axis must not renumber itself between weeks or the morph would slide.
  const maxBed = Math.max(...parsed.map((p) => p.bed));
  const maxZone = Math.max(...parsed.map((p) => p.zone));
  const bedNumbers = Array.from({ length: maxBed }, (_, i) => i + 1);
  const zoneNumbers = Array.from({ length: maxZone }, (_, i) => i + 1);

  const cols = zoneNumbers.length;
  const rows = bedNumbers.length;
  const n = cols * rows;

  const sum = new Float64Array(n);
  const hits = new Float64Array(n);
  for (const p of parsed) {
    const c = p.zone - 1;
    const r = p.bed - 1;
    if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
    const i = r * cols + c;
    sum[i] += p.value;
    hits[i] += 1;
  }

  const heights = new Float32Array(n);
  const measured = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (hits[i] > 0) {
      heights[i] = sum[i] / hits[i];
      measured[i] = 1;
    }
  }

  const confidence = new Float32Array(n);
  for (let i = 0; i < n; i++) confidence[i] = measured[i];

  fillByPyramid(heights, confidence, measured, cols, rows);

  // Same light blur as the projected field, so bed-to-bed steps flow.
  if (smoothPasses > 0 && n > 0) {
    const buf = new Float32Array(heights);
    for (let pass = 0; pass < smoothPasses; pass++) {
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          let acc = 0;
          let w = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
              const wt = dx === 0 && dy === 0 ? 4 : dx && dy ? 1 : 2;
              acc += heights[ny * cols + nx] * wt;
              w += wt;
            }
          }
          buf[y * cols + x] = acc / w;
        }
      }
      heights.set(buf);
    }
  }

  return {
    heights,
    confidence,
    measured,
    cols,
    rows,
    minX: 1,
    minY: 1,
    maxX: maxZone,
    maxY: maxBed,
    bedNumbers,
    zoneNumbers,
    identity: "axis",
  };
}

/** Bed/zone identity and value at a lattice cell — drives the hover tooltip. */
export function latticeCellAt(
  l: Lattice,
  col: number,
  row: number,
): { bed: number; zone: number; value: number; measured: boolean } | null {
  if (col < 0 || row < 0 || col >= l.cols || row >= l.rows) return null;
  const i = row * l.cols + col;
  const axis = l.identity === "axis";
  return {
    bed: axis ? l.bedNumbers[row] : l.bedNumbers[i],
    zone: axis ? l.zoneNumbers[col] : l.zoneNumbers[i],
    value: l.heights[i],
    measured: !!l.measured[i],
  };
}

/**
 * Ground-shape lattice: the surface laid out by real zone geometry, with bed and
 * zone identity carried along so hover still names the bed.
 *
 * Bed numbering in these houses is U-shaped, so bed 10 can physically sit beside
 * bed 140. `buildLattice` (bed-index space) deliberately ignores that — it is
 * for comparing beds BY NUMBER. This mode answers the other question: where on
 * the ground is the hotspot. Both are needed; neither replaces the other.
 *
 * Identity is resolved per grid cell by nearest sampled zone, so the tooltip
 * reports the bed whose observation actually drove that cell.
 */
export function buildGroundLattice(
  entries: LatticeEntry[],
  positions: Record<string, { x: number; y: number }>,
  opts: FieldOptions = {},
): Lattice {
  const pts: Array<{ x: number; y: number; value: number; bed: number; zone: number }> = [];
  for (const e of entries) {
    const pos = positions[e.name];
    const bz = parseBedZone(e.name);
    if (!pos || !bz) continue;
    pts.push({ x: pos.x, y: pos.y, value: e.value, bed: bz.bed, zone: bz.zone });
  }
  if (!pts.length) {
    return {
      ...buildHeightField([], opts),
      measured: new Uint8Array(0),
      bedNumbers: [],
      zoneNumbers: [],
      identity: "cell",
    };
  }

  const field = buildHeightField(
    pts.map((p) => ({ x: p.x, y: p.y, value: p.value })),
    opts,
  );

  // Per-cell bed/zone by nearest sample. bedNumbers/zoneNumbers are indexed by
  // FLAT CELL here rather than by row/col — `latticeCellAt` reads them the same
  // way for both layouts because it indexes with row*cols+col for the value and
  // the same flat index for identity.
  const n = field.cols * field.rows;
  const bedAt = new Array<number>(n).fill(0);
  const zoneAt = new Array<number>(n).fill(0);
  const measured = new Uint8Array(n);
  const spanX = field.maxX - field.minX || 1;
  const spanY = field.maxY - field.minY || 1;

  // Nearest-sample assignment via a coarse bucket grid, so this stays linear
  // rather than cells × samples (4,914 zones × ~12k cells would not do).
  const buckets = new Map<string, typeof pts>();
  const BK = 16;
  const bkey = (cx: number, cy: number) => `${cx},${cy}`;
  for (const p of pts) {
    const cx = Math.floor(((p.x - field.minX) / spanX) * BK);
    const cy = Math.floor(((p.y - field.minY) / spanY) * BK);
    const k = bkey(cx, cy);
    const arr = buckets.get(k);
    if (arr) arr.push(p);
    else buckets.set(k, [p]);
  }

  for (let r = 0; r < field.rows; r++) {
    for (let c = 0; c < field.cols; c++) {
      const wx = field.minX + (c / Math.max(1, field.cols - 1)) * spanX;
      const wy = field.minY + (r / Math.max(1, field.rows - 1)) * spanY;
      const cx = Math.floor(((wx - field.minX) / spanX) * BK);
      const cy = Math.floor(((wy - field.minY) / spanY) * BK);
      let best: (typeof pts)[number] | null = null;
      let bestD = Infinity;
      // Search the containing bucket and its ring; widen only if empty.
      for (let ring = 0; ring <= BK && !best; ring++) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dx = -ring; dx <= ring; dx++) {
            if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
            const arr = buckets.get(bkey(cx + dx, cy + dy));
            if (!arr) continue;
            for (const p of arr) {
              const d = (p.x - wx) ** 2 + (p.y - wy) ** 2;
              if (d < bestD) {
                bestD = d;
                best = p;
              }
            }
          }
        }
      }
      const i = r * field.cols + c;
      if (best) {
        bedAt[i] = best.bed;
        zoneAt[i] = best.zone;
        // "Measured" here means a real sample sits essentially on this cell.
        const cellSize = Math.max(spanX / field.cols, spanY / field.rows);
        measured[i] = bestD <= cellSize * cellSize ? 1 : 0;
      }
    }
  }

  return {
    ...field,
    measured,
    bedNumbers: bedAt,
    zoneNumbers: zoneAt,
    identity: "cell",
  };
}
