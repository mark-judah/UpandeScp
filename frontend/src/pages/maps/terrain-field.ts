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
}

/** Weeks the playback may step through.
 *
 *  Incomplete weeks are dropped: interpolation stops a half-scouted week from
 *  collapsing, but it cannot manufacture information. A week sampled from one
 *  bed parity is a materially weaker estimate, and stepping through it beside
 *  full weeks would give a guess the authority of a measurement. */
export function playableWeeks<T extends TerrainWeek>(weeks: T[]): T[] {
  return weeks.filter((w) => w.complete !== false);
}

/** Timeline entries for every week in range, marking which are playable.
 *
 *  Skipped weeks keep their slot: silently compressing them would misrepresent
 *  the cadence, and a jump from W27 to W30 must read as a data gap rather than
 *  three quiet weeks. */
export function timeline<T extends TerrainWeek>(
  weeks: T[],
): Array<{ week: T; playable: boolean; frame: number | null }> {
  let frame = 0;
  return weeks.map((week) => {
    const playable = week.complete !== false;
    return { week, playable, frame: playable ? frame++ : null };
  });
}
