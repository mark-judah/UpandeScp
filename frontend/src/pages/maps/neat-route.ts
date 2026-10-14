/**
 * Neat scout routes — display-only tidy-up of a scout's zone-by-zone trail.
 *
 * Scouts often forget to check in at the very start and end of a bed, so the
 * raw trail (centroid to centroid) stops short of the bed edges and zig-zags
 * raggedly. This closes those gaps on screen without touching stored data:
 *
 *   1. The last ping on a bed is on its last or second-to-last zone (in the
 *      scout's walking direction) → the line carries on, solid, to the bed's
 *      END zone, the edge that leads to the next bed.
 *   2. The first ping on a bed is on its second zone → the line starts at the
 *      bed's START zone, the edge the scout came in from.
 *   3. A bigger gap (the first/last real ping is 2+ zones in from the edge) →
 *      the missing stretch is drawn DOTTED, up to the zone actually pinged.
 *      Segments between real pings always stay solid.
 *
 * Beds are only joined when they are neighbours — bed numbers within
 * `MAX_BED_STEP`, or the exit within reach of the next entry (`opts.near`). A
 * jump across the house breaks the line there instead of drawing a long
 * diagonal; the trail carries on as a separate piece.
 *
 * The walking direction on a bed is read from its own pings (first → last
 * zone number); a bed with a single zone, or one that ends where it began, is
 * left alone — there is no direction to extend along.
 */

export type Pt = [number, number];

export interface RoutePing {
  bed: string;
  /** Zone number within the bed (1-based). */
  zone: number;
}

export interface BedGeometry {
  /** Zones on the bed — the number of its last zone. */
  zoneCount: number;
  /** Centroid of a zone, or undefined when the zone has no geometry. */
  point(zone: number): Pt | undefined;
}

export interface NeatOptions {
  /** Whether two points are close enough (about 1.5 bed-widths) to be joined
   *  even when the bed numbers say otherwise. */
  near?: (a: Pt, b: Pt) => boolean;
}

/** Beds this close in number are neighbours and always joined. */
export const MAX_BED_STEP = 2;

/** "GH 11 - KR - Bed 212" → 212 (NaN when absent). */
export function bedNumber(bed: string): number {
  const m = /Bed\s+(\d+)/i.exec(bed || "");
  return m ? Number(m[1]) : NaN;
}

export interface RouteSegment {
  points: Pt[];
  dashed: boolean;
}

/** "GH 11 - KR - Bed 3 - Zone 12" → 12 (NaN when the name has no zone number). */
export function zoneNumber(zoneName: string): number {
  const m = /Zone\s+(\d+)\s*$/i.exec(zoneName || "");
  return m ? Number(m[1]) : NaN;
}

interface Node {
  pt: Pt;
  /** The edge from the previous node to this one is dotted. */
  dashed: boolean;
  /** No edge from the previous node: the trail breaks here. */
  brk?: boolean;
}

export function neatRoute(
  pings: RoutePing[],
  bedOf: (bed: string) => BedGeometry | undefined,
  opts: NeatOptions = {},
): RouteSegment[] {
  // Runs of consecutive pings on the same bed, repeated zones collapsed.
  const runs: { bed: string; zones: number[] }[] = [];
  for (const p of pings) {
    if (!Number.isFinite(p.zone)) continue;
    const run = runs[runs.length - 1];
    if (run && run.bed === p.bed) {
      if (run.zones[run.zones.length - 1] !== p.zone) run.zones.push(p.zone);
    } else {
      runs.push({ bed: p.bed, zones: [p.zone] });
    }
  }

  const nodes: Node[] = [];
  let prevBed = "";
  for (const run of runs) {
    const geo = bedOf(run.bed);
    if (!geo) continue;
    const { zones } = run;
    const first = zones[0];
    const last = zones[zones.length - 1];
    const real: Node[] = [];
    zones.forEach((z) => {
      const pt = geo.point(z);
      if (pt) real.push({ pt, dashed: false });
    });
    if (!real.length) continue;

    if (zones.length >= 2 && first !== last) {
      const asc = last > first;
      const entry = asc ? 1 : geo.zoneCount;
      const exit = asc ? geo.zoneCount : 1;
      const entryPt = geo.point(entry);
      const exitPt = geo.point(exit);
      const gapIn = Math.abs(first - entry);
      const gapOut = Math.abs(exit - last);
      // The edge from the implied entry to the first real ping is dotted from
      // a 2+ zone gap; one zone away reads as part of the walk.
      if (gapIn > 0 && entryPt) {
        real.unshift({ pt: entryPt, dashed: false });
        real[1].dashed = gapIn >= 2;
      }
      if (gapOut > 0 && exitPt) {
        real.push({ pt: exitPt, dashed: gapOut >= 2 });
      }
    }
    // The hop from the previous bed's exit is solid — but only between
    // neighbours; a far jump breaks the trail.
    if (nodes.length) {
      const step = Math.abs(bedNumber(run.bed) - bedNumber(prevBed));
      const joined =
        Number.isNaN(step) || step <= MAX_BED_STEP || !!opts.near?.(nodes[nodes.length - 1].pt, real[0].pt);
      if (!joined) real[0].brk = true;
    }
    prevBed = run.bed;
    nodes.push(...real);
  }

  // Fold nodes into segments, one per run of equally-styled edges. Each
  // segment repeats the previous point so the polyline stays continuous.
  const out: RouteSegment[] = [];
  let fresh = false;
  nodes.forEach((n, i) => {
    if (i === 0) return;
    if (n.brk) {
      fresh = true;
      return;
    }
    const prev = nodes[i - 1].pt;
    const tail = out[out.length - 1];
    if (tail && !fresh && tail.dashed === n.dashed) tail.points.push(n.pt);
    else out.push({ points: [prev, n.pt], dashed: n.dashed });
    fresh = false;
  });
  // A lone final ping after a break has no edge, but it is still where the
  // route ends — keep it as a one-point piece so the end node lands there.
  const lastNode = nodes[nodes.length - 1];
  const tail = out[out.length - 1];
  if (nodes.length > 1 && (!tail || tail.points[tail.points.length - 1] !== lastNode.pt)) {
    out.push({ points: [lastNode.pt], dashed: false });
  }
  return out;
}

/** Where a route ends (the end-node badge sits here). */
export function routeEnd(segments: RouteSegment[], fallback?: Pt): Pt | undefined {
  const tail = segments[segments.length - 1];
  return tail ? tail.points[tail.points.length - 1] : fallback;
}
