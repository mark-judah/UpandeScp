/** Convex hulls for patch and pin outlines (spread spec §6): the same code
 *  draws in SVG space (BedSvg) and in lng/lat (the avocado map). */
export type Pt = [number, number];

const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Monotone chain. Repeats dropped; collinear points collapse to the two ends
 *  (a patch along one bed outlines as a line). */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p] as const)).values()].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1],
  );
  if (pts.length <= 2) return pts;
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** "M x y L x y … Z" (2 dp); "" for no points. */
export function outlinePath(hull: Pt[]): string {
  if (!hull.length) return "";
  return `${hull.map((p, i) => `${i ? "L" : "M"}${fmt(p[0])} ${fmt(p[1])}`).join(" ")} Z`;
}

/** The hull with its first point repeated at the end (a closed GeoJSON ring). */
export function closedRing(hull: Pt[]): Pt[] {
  return hull.length ? [...hull, hull[0]] : [];
}
