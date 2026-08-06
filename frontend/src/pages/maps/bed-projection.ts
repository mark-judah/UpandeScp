/**
 * Slim bed-projection — ports just the parts of upright-svg.ts that the
 * symbol-instance heatmap POC needs: bed paths (one per ``line_id``) and
 * per-zone centroids. Skips the per-zone polyline output, the block-
 * clustering, and the label-slot placement.
 *
 * One projection per greenhouse-zone-array; memoise at the call site.
 */

export interface ZoneGeoLike {
  /** Zone name as it appears in the Zone doctype and Scouting Entry.zone. */
  name: string;
  /** The zone's 2-point bed-line segment, decoded from the compact
   *  ``getBedsAndZones`` payload — what ``fetchBedsAndZones`` ships today. */
  coords?: [[number, number], [number, number]];
  /** Shared bed identifier for ``coords`` (``properties.line_id`` in the
   *  old GeoJSON). */
  lineId?: unknown;
  /** Legacy escape hatch: an already-parsed FeatureCollection object (never
   *  a JSON string — no consumer should be calling JSON.parse on this
   *  payload anymore). Typed loosely (some call sites carry it through an
   *  ``as unknown as string`` cast from older code) since it's read
   *  defensively at runtime regardless. Used by pages that build
   *  ``ZoneGeoLike`` from ``zone-utils.ts``'s synthesised
   *  ``ZoneFeature.geometry`` instead of a raw ``coords``/``lineId`` pair
   *  (e.g. the Heatmaps page). */
  raw_geojson?: any;
}

export interface BedPath {
  /** ``line_id`` value from the source GeoJSON — the stable bed identifier. */
  bedId: string;
  /** Concatenated SVG path "M x y L x y L … M x y L …", one moveto per
   *  ring belonging to this bed. */
  d: string;
  /** Position to drop a label for this bed: just to the left of the
   *  leftmost point along the bed's centerline. ``labelY`` is the bed's
   *  centroid in SVG y. */
  labelX: number;
  labelY: number;
}

export interface ProjectedGeometry {
  viewBox: string;
  width: number;
  height: number;
  beds: BedPath[];
  /** Centroid for every zone that had at least one valid feature. Coords
   *  are in the same SVG space as ``beds`` (post-projection, padded). */
  zoneCentroids: Record<string, { cx: number; cy: number }>;
}

interface RawRing {
  zoneName: string;
  bedId: string;
  points: number[][];
}

function collectRings(zones: ZoneGeoLike[]): RawRing[] {
  const out: RawRing[] = [];
  for (const z of zones) {
    // Fast path: coords/lineId decoded directly from the compact payload —
    // no GeoJSON, no parsing.
    if (Array.isArray(z.coords) && z.coords.length === 2) {
      const lid = z.lineId;
      if (lid == null || lid === "") continue;
      out.push({
        zoneName: z.name,
        bedId: String(lid),
        points: z.coords.map((p) => [p[0], p[1]]),
      });
      continue;
    }
    // Legacy path: an already-parsed FeatureCollection object (see
    // ZoneGeoLike.raw_geojson) — still no JSON.parse here.
    const geo = z.raw_geojson;
    if (!geo?.features) continue;
    for (const f of geo.features) {
      const c = f?.geometry?.coordinates;
      const lid = f?.properties?.line_id;
      if (!Array.isArray(c) || !c.length) continue;
      if (lid == null || lid === "") continue;
      out.push({
        zoneName: z.name,
        bedId: String(lid),
        points: (c as number[][]).map((p) => [p[0], p[1]]),
      });
    }
  }
  return out;
}

function bedDirection(rings: RawRing[], latScale: number): number {
  // Doubled-angle mean so 0° and 180° lines don't cancel out.
  let sumCos = 0;
  let sumSin = 0;
  let found = false;
  for (const r of rings) {
    if (r.points.length < 2) continue;
    const a0 = r.points[0];
    const a1 = r.points[r.points.length - 1];
    const dx = (a1[0] - a0[0]) * latScale;
    const dy = a1[1] - a0[1];
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-20) continue;
    const len = Math.sqrt(len2);
    const a = Math.atan2(dy, dx);
    sumCos += Math.cos(2 * a) * len;
    sumSin += Math.sin(2 * a) * len;
    found = true;
  }
  return found ? 0.5 * Math.atan2(sumSin, sumCos) : 0;
}

export function projectGeometry(
  zones: ZoneGeoLike[],
  targetW = 1100,
  targetH = 560,
): ProjectedGeometry | null {
  const rings = collectRings(zones);
  if (!rings.length) return null;

  // Equirectangular: scale longitude by cos(meanLat) so the projection
  // preserves aspect.
  let sumLat = 0;
  let nPts = 0;
  for (const r of rings) {
    for (const p of r.points) {
      sumLat += p[1];
      nPts++;
    }
  }
  if (!nPts) return null;
  const meanLat = sumLat / nPts;
  const latScale = Math.cos((meanLat * Math.PI) / 180);

  const dir = bedDirection(rings, latScale);
  const rot = -dir; // rotate so bed lines run horizontally
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);

  let cxRaw = 0;
  let cyRaw = 0;
  for (const r of rings) {
    for (const [lng, lat] of r.points) {
      cxRaw += lng * latScale;
      cyRaw += lat;
    }
  }
  cxRaw /= nPts;
  cyRaw /= nPts;

  const project = (lng: number, lat: number): [number, number] => {
    const x = lng * latScale - cxRaw;
    const y = lat - cyRaw;
    return [x * cosR - y * sinR, x * sinR + y * cosR];
  };

  // Project all points, track bbox.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  type ProjRing = { zoneName: string; bedId: string; pts: [number, number][] };
  const projRings: ProjRing[] = rings.map((r) => {
    const pts: [number, number][] = r.points.map(([lng, lat]) => {
      const p = project(lng, lat);
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
      return p;
    });
    return { zoneName: r.zoneName, bedId: r.bedId, pts };
  });
  const w = maxX - minX;
  const h = maxY - minY;
  if (w === 0 || h === 0) return null;

  // Pad + scale into SVG viewport. Flip Y so north is up.
  const PAD = 14;
  const LABEL_MARGIN = 24;
  const scale = Math.min(
    (targetW - LABEL_MARGIN - PAD) / w,
    (targetH - 2 * PAD) / h,
  );
  const svgW = w * scale + LABEL_MARGIN + PAD;
  const svgH = h * scale + 2 * PAD;
  const toSvg = (x: number, y: number): [number, number] => [
    LABEL_MARGIN + (x - minX) * scale,
    PAD + (maxY - y) * scale,
  ];

  // Group rings by bedId; concatenate into one path with one M per ring.
  const bedRings: Record<string, ProjRing[]> = {};
  for (const r of projRings) {
    if (!bedRings[r.bedId]) bedRings[r.bedId] = [];
    bedRings[r.bedId].push(r);
  }
  const beds: BedPath[] = Object.entries(bedRings).map(([bedId, rs]) => {
    const segments: string[] = [];
    let minSvgX = Infinity;
    let sumY = 0;
    let nPts = 0;
    for (const r of rs) {
      if (r.pts.length < 2) continue;
      const parts: string[] = [];
      for (let i = 0; i < r.pts.length; i++) {
        const [sx, sy] = toSvg(r.pts[i][0], r.pts[i][1]);
        parts.push(`${i === 0 ? "M" : "L"}${sx.toFixed(2)} ${sy.toFixed(2)}`);
        if (sx < minSvgX) minSvgX = sx;
        sumY += sy;
        nPts += 1;
      }
      segments.push(parts.join(" "));
    }
    const labelX = minSvgX === Infinity ? 0 : minSvgX - 2;
    const labelY = nPts > 0 ? sumY / nPts : 0;
    return { bedId, d: segments.join(" "), labelX, labelY };
  });

  // Zone centroids: mean of all that zone's projected points.
  const accum: Record<string, { sx: number; sy: number; n: number }> = {};
  for (const r of projRings) {
    let a = accum[r.zoneName];
    if (!a) {
      a = { sx: 0, sy: 0, n: 0 };
      accum[r.zoneName] = a;
    }
    for (const [x, y] of r.pts) {
      const [sx, sy] = toSvg(x, y);
      a.sx += sx;
      a.sy += sy;
      a.n += 1;
    }
  }
  const zoneCentroids: Record<string, { cx: number; cy: number }> = {};
  for (const [name, a] of Object.entries(accum)) {
    if (a.n > 0) {
      zoneCentroids[name] = { cx: a.sx / a.n, cy: a.sy / a.n };
    }
  }

  return {
    viewBox: `0 0 ${svgW.toFixed(2)} ${svgH.toFixed(2)}`,
    width: svgW,
    height: svgH,
    beds,
    zoneCentroids,
  };
}
