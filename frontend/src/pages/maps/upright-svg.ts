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
  /** A FeatureCollection where each feature is one bed-line LineString. */
  raw_geojson: string | null | undefined;
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

export interface UprightSvgResult {
  svg: string;
  width: number;
  height: number;
}

function parseRawGeo(raw: ZoneGeo["raw_geojson"]): any | null {
  if (!raw) return null;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
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

export function buildGreenhouseUprightSvg(
  zones: ZoneGeo[],
  zoneObs: Record<string, ZoneObs>,
  options: { width?: number; height?: number } = {},
): UprightSvgResult | null {
  if (!zones.length) return null;

  // 1. Collect rings per zone with line_id metadata.
  const internal: InternalZone[] = [];
  const allPoints: number[][] = [];
  for (const z of zones) {
    const geo = parseRawGeo(z.raw_geojson);
    if (!geo?.features) continue;
    const rings: number[][][] = [];
    const lineIds: (string | number | null)[] = [];
    for (const f of geo.features as any[]) {
      const c = f?.geometry?.coordinates;
      if (Array.isArray(c) && c.length) {
        const ring = (c as number[][]).map((p) => [p[0], p[1]]);
        rings.push(ring);
        lineIds.push(f?.properties?.line_id ?? null);
        for (const p of ring) allPoints.push(p);
      }
    }
    if (rings.length) internal.push({ name: z.name, rings, lineIds });
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
  const projected = internal.map((z) => {
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

  // 5. SVG viewport math (label margin on the left).
  const PAD = 16;
  const LABEL_MARGIN = 24;
  const padLeft = LABEL_MARGIN;
  const padRight = PAD;
  const TARGET_W = options.width ?? 1100;
  const TARGET_H = options.height ?? 760;
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

  // 6. Bed thickness (cluster centroids on each axis).
  const countClusters = (vals: number[], tol: number): number => {
    if (!vals.length) return 1;
    const s = vals.slice().sort((a, b) => a - b);
    let n = 1;
    for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] > tol) n++;
    return n;
  };
  const yCenters = bedMeta.map((b) => b.cy);
  const xCenters = bedMeta.map((b) => b.cx);
  const yClusters = countClusters(yCenters, h * 0.02);
  const xClusters = countClusters(xCenters, w * 0.02);
  const stackExtent = (yClusters >= xClusters ? h : w) * scale;
  const stackedBeds = Math.max(1, Math.max(yClusters, xClusters));
  const bedSpacing = stackExtent / stackedBeds;
  const bedThickness = Math.max(1.5, Math.min(4, bedSpacing * 0.25));

  // 7. Layers: baselines, colored polylines, bed labels.
  let baselines = "";
  for (const blk of blocks) {
    for (const bed of blk.beds) {
      const [x0, y0] = toSvg([blk.maxX, bed.cy]);
      const [x1, y1] = toSvg([blk.minX, bed.cy]);
      baselines += `<line class="gh-bed-baseline" x1="${x0.toFixed(2)}" y1="${y0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}"/>`;
    }
  }

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

  let labels = "";
  for (const blk of blocks) {
    for (const bed of blk.beds) {
      const [ix, iy] = toSvg([blk.minX, bed.cy]);
      const safeLid = String(bed.lid).replace(/&/g, "&amp;").replace(/</g, "&lt;");
      labels += `<text class="gh-bed-label" x="${(ix - 4).toFixed(2)}" y="${iy.toFixed(2)}" text-anchor="end">${safeLid}</text>`;
    }
  }

  return {
    svg: `<svg viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">${baselines}${body}${labels}</svg>`,
    width: svgW,
    height: svgH,
  };
}
