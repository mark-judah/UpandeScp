import type { HexSet } from "@/lib/field-geo";

/** Hexagon (triad) name → its centre [lng, lat], the mean of the ring's corners. */
export function hexCentroids(hex: HexSet): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const f of hex.fc.features) {
    const ring = f.geometry.coordinates[0] || [];
    // The ring is closed (last = first); don't count that corner twice.
    const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
    if (!pts.length) continue;
    let x = 0;
    let y = 0;
    for (const [px, py] of pts) {
      x += px;
      y += py;
    }
    out.set(f.properties.n, [x / pts.length, y / pts.length]);
  }
  return out;
}
