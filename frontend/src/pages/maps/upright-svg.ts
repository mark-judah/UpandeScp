/**
 * Greenhouse upright-view SVG renderer — direct port of the
 * `buildGreenhouseSVG` block in upande_scp/www/observations_map/index.html
 * (lines 700–960).
 *
 * Takes zone GeoJSON features (one per bed line, with a `line_id`
 * property), projects them with equirectangular scaling, rotates so beds
 * run horizontally, then emits one polyline per bed-segment colored by
 * the per-zone observation count.
 *
 * Used by:
 *   - Application Plan diagnose step
 *   - (future) any page that wants the same modal-style heatmap
 */

export interface ZoneObs {
  /** Total observations in this zone for the active filter. */
  count: number;
  /** Hex color for the dominant pest/disease in this zone. */
  color: string;
}

export interface ZoneGeo {
  /** Zone name as it appears in the Zone doctype (and on Scouting Entry.zone). */
  name: string;
  /** The zone's 2-point bed-line segment, decoded from the compact
   *  ``getBedsAndZones`` payload. */
  coords: [[number, number], [number, number]];
  /** Shared bed identifier (``properties.line_id`` in the old GeoJSON). */
  lineId: string | number | null | undefined;
}

interface InternalZone {
  name: string;
  rings: number[][][];
  lineIds: (string | number | null)[];
}

interface InternalRing {
  lid: string | number;
  ring: number[][];
  cx: number;
  cy: number;
  minX: number;
  maxX: number;
}

interface BedMeta {
  lid: string | number;
  minX: number;
  maxX: number;
  cx: number;
  cy: number;
}

interface BlockMeta {
  rings: InternalRing[];
  minX: number;
  maxX: number;
  beds: BedMeta[];
}

interface ProjectedZone {
  name: string;
  rings: number[][][];
  lineIds: (string | number | null)[];
}

interface CachedGeometry {
  projected: ProjectedZone[];
  blocks: BlockMeta[];
  bedLeftmost: Map<
    string,
    { lid: string | number; cy: number; blockIdx: number }
  >;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  w: number;
  h: number;
  /** Stacked-bed count along the dominant axis — used for spacing/font. */
  stackedBeds: number;
}

export interface UprightSvgResult {
  svg: string;
  width: number;
  height: number;
}

/** Robust direction of bed lines (averaged over circular doubling so 0° and
 *  180° lines don't cancel). Falls back to the PCA of all points. */
function bedLineAngle(
  zones: InternalZone[],
  latScale: number,
): number | null {
  let sumCos = 0;
  let sumSin = 0;
  let found = false;
  for (const z of zones) {
    for (const ring of z.rings) {
      if (!ring || ring.length < 2) continue;
      const first = ring[0];
      const last = ring[ring.length - 1];
      const dx = (last[0] - first[0]) * latScale;
      const dy = last[1] - first[1];
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-20) continue;
      const a = Math.atan2(dy, dx);
      const len = Math.sqrt(len2);
      sumCos += Math.cos(2 * a) * len;
      sumSin += Math.sin(2 * a) * len;
      found = true;
    }
  }
  if (!found) return null;
  return 0.5 * Math.atan2(sumSin, sumCos);
}

function pcaAngle(points: number[][], latScale: number): number {
  let sx = 0;
  let sy = 0;
  for (const [lng, lat] of points) {
    sx += lng * latScale;
    sy += lat;
  }
  const mx = sx / points.length;
  const my = sy / points.length;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const [lng, lat] of points) {
    const x = lng * latScale - mx;
    const y = lat - my;
    xx += x * x;
    xy += x * y;
    yy += y * y;
  }
  return 0.5 * Math.atan2(2 * xy, xx - yy);
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

/** WeakMap-cached projection + clustering. The Heatmaps page memoizes the
 *  per-greenhouse zones array, so the same array reference comes back on
 *  every re-render — re-projecting/clustering each time was ~20-40ms per
 *  card on multi-block greenhouses, and the page renders 20+ cards. */
const geomCache = new WeakMap<object, CachedGeometry | null>();

function prepareGeometry(zones: ZoneGeo[]): CachedGeometry | null {
  // 1. Collect rings per zone with line_id metadata.
  const internal: InternalZone[] = [];
  const allPoints: number[][] = [];
  for (const z of zones) {
    if (!Array.isArray(z.coords) || z.coords.length !== 2) continue;
    const ring = z.coords.map((p) => [p[0], p[1]]);
    for (const p of ring) allPoints.push(p);
    internal.push({ name: z.name, rings: [ring], lineIds: [z.lineId ?? null] });
  }
  if (!allPoints.length) return null;

  // 2. Equirectangular projection (preserves aspect).
  let sumLat = 0;
  for (const [, lat] of allPoints) sumLat += lat;
  const meanLat = sumLat / allPoints.length;
  const latScale = Math.cos((meanLat * Math.PI) / 180);

  let bedDir = bedLineAngle(internal, latScale);
  if (bedDir === null) bedDir = pcaAngle(allPoints, latScale);
  const rot = -bedDir;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);

  let cxRaw = 0;
  let cyRaw = 0;
  for (const [lng, lat] of allPoints) {
    cxRaw += lng * latScale;
    cyRaw += lat;
  }
  cxRaw /= allPoints.length;
  cyRaw /= allPoints.length;

  const project = ([lng, lat]: number[]): [number, number] => {
    const x = lng * latScale - cxRaw;
    const y = lat - cyRaw;
    return [x * cos - y * sin, x * sin + y * cos];
  };

  // 3. Project + bbox.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const projected: ProjectedZone[] = internal.map((z) => {
    const rings = z.rings.map((ring) => {
      const out = ring.map(project);
      for (const [x, y] of out) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      return out;
    });
    return { name: z.name, rings, lineIds: z.lineIds };
  });
  const w = maxX - minX;
  const h = maxY - minY;
  if (w === 0 || h === 0) return null;

  // 4. Cluster rings into horizontal "blocks" by gap.
  const allRings: InternalRing[] = [];
  for (const z of projected) {
    for (let i = 0; i < z.rings.length; i++) {
      const lid = z.lineIds[i];
      const ring = z.rings[i];
      if (lid == null || lid === "" || !ring.length) continue;
      let sx = 0;
      let sy = 0;
      let mn = Infinity;
      let mx = -Infinity;
      for (const [x, y] of ring) {
        sx += x;
        sy += y;
        if (x < mn) mn = x;
        if (x > mx) mx = x;
      }
      allRings.push({
        lid: lid as string | number,
        ring,
        cx: sx / ring.length,
        cy: sy / ring.length,
        minX: mn,
        maxX: mx,
      });
    }
  }
  const sortedRings = allRings.slice().sort((a, b) => a.cx - b.cx);
  const GAP_THRESHOLD = w * 0.05;
  const blocks: BlockMeta[] = [];
  for (const r of sortedRings) {
    const last = blocks[blocks.length - 1];
    if (!last || r.cx > last.maxX + GAP_THRESHOLD) {
      blocks.push({ rings: [r], minX: r.minX, maxX: r.maxX, beds: [] });
    } else {
      last.rings.push(r);
      if (r.maxX > last.maxX) last.maxX = r.maxX;
      if (r.minX < last.minX) last.minX = r.minX;
    }
  }
  for (const blk of blocks) {
    const bedMap: Record<string, { lid: string | number; pts: number[][] }> = {};
    for (const r of blk.rings) {
      const key = String(r.lid);
      if (!bedMap[key]) bedMap[key] = { lid: r.lid, pts: [] };
      for (const p of r.ring) bedMap[key].pts.push(p);
    }
    blk.beds = Object.values(bedMap).map((b) => {
      let mn = Infinity;
      let mx = -Infinity;
      let sx = 0;
      let sy = 0;
      for (const [x, y] of b.pts) {
        if (x < mn) mn = x;
        if (x > mx) mx = x;
        sx += x;
        sy += y;
      }
      return {
        lid: b.lid,
        minX: mn,
        maxX: mx,
        cx: sx / b.pts.length,
        cy: sy / b.pts.length,
      };
    });
  }
  const bedMeta: BedMeta[] = blocks.flatMap((blk) => blk.beds);

  // For each unique bed lid, remember the leftmost block it appears in.
  const bedLeftmost = new Map<
    string,
    { lid: string | number; cy: number; blockIdx: number }
  >();
  for (let bi = 0; bi < blocks.length; bi++) {
    for (const bed of blocks[bi].beds) {
      const k = String(bed.lid);
      if (!bedLeftmost.has(k)) {
        bedLeftmost.set(k, { lid: bed.lid, cy: bed.cy, blockIdx: bi });
      }
    }
  }

  // Stacked-bed count along the dominant axis (used for spacing/font in render).
  const countClusters = (vals: number[], tol: number): number => {
    if (!vals.length) return 1;
    const s = vals.slice().sort((a, b) => a - b);
    let n = 1;
    for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] > tol) n++;
    return n;
  };
  const yClusters = countClusters(
    bedMeta.map((b) => b.cy),
    h * 0.02,
  );
  const xClusters = countClusters(
    bedMeta.map((b) => b.cx),
    w * 0.02,
  );
  const stackedBeds = Math.max(1, Math.max(yClusters, xClusters));

  return {
    projected,
    blocks,
    bedLeftmost,
    minX,
    maxX,
    minY,
    maxY,
    w,
    h,
    stackedBeds,
  };
}

function getGeometry(zones: ZoneGeo[]): CachedGeometry | null {
  const cached = geomCache.get(zones);
  if (cached !== undefined) return cached;
  const fresh = prepareGeometry(zones);
  geomCache.set(zones, fresh);
  return fresh;
}

export function buildGreenhouseUprightSvg(
  zones: ZoneGeo[],
  zoneObs: Record<string, ZoneObs>,
  options: { width?: number; height?: number } = {},
): UprightSvgResult | null {
  if (!zones.length) return null;

  const geom = getGeometry(zones);
  if (!geom) return null;
  const { projected, blocks, bedLeftmost, minX, maxY, w, h, stackedBeds } = geom;

  // SVG viewport math (label margin on the left). Defaults sized for the
  // heatmap card grid + modal strips — wider than the old 720×420 so
  // multi-block greenhouses don't crush their corridors. Callers can
  // override via ``options``.
  const PAD = 14;
  const LABEL_MARGIN = 24;
  const padLeft = LABEL_MARGIN;
  const padRight = PAD;
  const TARGET_W = options.width ?? 1100;
  const TARGET_H = options.height ?? 560;
  const scale = Math.min(
    (TARGET_W - padLeft - padRight) / w,
    (TARGET_H - 2 * PAD) / h,
  );
  const svgW = w * scale + padLeft + padRight;
  const svgH = h * scale + 2 * PAD;

  const toSvg = ([x, y]: number[]): [number, number] => [
    padLeft + (x - minX) * scale,
    PAD + (maxY - y) * scale,
  ];

  // Bed thickness (tighter than the modal version — 0.7-2 px reads as a
  // fine line, never a fat ribbon).
  const stackExtent = h * scale;
  const bedSpacing = stackExtent / stackedBeds;
  const bedThickness = Math.max(0.7, Math.min(2, bedSpacing * 0.2));

  // Layer 1 — baselines.
  let baselines = "";
  for (const blk of blocks) {
    for (const bed of blk.beds) {
      const [x0, y0] = toSvg([blk.maxX, bed.cy]);
      const [x1, y1] = toSvg([blk.minX, bed.cy]);
      baselines += `<line class="gh-bed-baseline" x1="${x0.toFixed(2)}" y1="${y0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}"/>`;
    }
  }

  // Layer 2 — colored polylines per zone.
  const counts = Object.values(zoneObs).map((o) => o.count);
  const maxCount = counts.length ? Math.max(...counts, 1) : 1;

  let body = "";
  for (const z of projected) {
    const obs = zoneObs[z.name];
    const count = obs?.count || 0;
    let color = "#cbd5e1";
    if (obs && count > 0 && obs.color) color = obs.color;
    const hasObs = count > 0;
    const ratio = hasObs ? Math.min(1, count / maxCount) : 0;
    const opacity = hasObs ? 0.7 + ratio * 0.3 : 0.55;
    const safeName = escapeAttr(z.name);

    for (const ring of z.rings) {
      if (ring.length < 2) continue;
      const pts = ring.map((p) => toSvg(p).join(",")).join(" ");
      body +=
        `<polyline class="gh-zone" data-zone="${safeName}" points="${pts}" ` +
        `fill="none" stroke="${color}" stroke-width="${bedThickness.toFixed(2)}" ` +
        `stroke-opacity="${opacity}" stroke-linecap="round">` +
        `<title>${safeName}${hasObs ? " · " + count : ""}</title></polyline>`;
    }
  }

  // Layer 3 — bed labels.
  //
  // Each bed lid gets exactly ONE label. Labels live in "slots": the
  // leftmost gutter, plus one corridor between each pair of adjacent
  // blocks. With a single block there is one slot (leftmost) and every
  // label stacks there. With 2+ blocks we round-robin labels across the
  // available slots — sorted top-to-bottom so each slot ends up with
  // well-spaced labels (e.g. with 4 blocks and 12 beds, each slot holds
  // 3 labels at every-fourth-row spacing). This is the fix for the old
  // "all 12 labels stacked on the leftmost edge and overlapping" look
  // when a wide greenhouse splits into 4+ strips.
  const safeLabel = (lid: string | number) =>
    String(lid).replace(/&/g, "&amp;").replace(/</g, "&lt;");

  type LabelSlot = { svgX: number; anchor: "end" | "middle" };
  const slots: LabelSlot[] = [];
  {
    const [tx0] = toSvg([blocks[0].minX, 0]);
    slots.push({ svgX: tx0 - 4, anchor: "end" });
    for (let i = 1; i < blocks.length; i++) {
      const cx = (blocks[i - 1].maxX + blocks[i].minX) / 2;
      const [tx] = toSvg([cx, 0]);
      slots.push({ svgX: tx, anchor: "middle" });
    }
  }

  // Top-to-bottom in SVG = descending projected-y (toSvg flips the axis).
  const sortedBeds = [...bedLeftmost.values()].sort((a, b) => b.cy - a.cy);

  // Font scales with bed spacing so card thumbnails stay legible without
  // overflowing rows. Clamp to a 4-6 px window — small enough to fit
  // between bed rows on tightly-packed greenhouses, large enough to read
  // on the modal at full size.
  const fontPx = Math.max(4, Math.min(6, bedSpacing * 0.55));

  let labels = "";
  sortedBeds.forEach((bed, idx) => {
    const slot = slots[idx % slots.length];
    const [, ty] = toSvg([0, bed.cy]);
    labels +=
      `<text class="gh-bed-label" x="${slot.svgX.toFixed(2)}" ` +
      `y="${ty.toFixed(2)}" font-size="${fontPx.toFixed(2)}" ` +
      `text-anchor="${slot.anchor}">${safeLabel(bed.lid)}</text>`;
  });

  return {
    svg: `<svg viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">${baselines}${body}${labels}</svg>`,
    width: svgW,
    height: svgH,
  };
}
