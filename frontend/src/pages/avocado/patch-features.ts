import type { GeoJsonFC } from "@/lib/scouting-api";
import { closedRing, convexHull, type Pt } from "@/lib/hull";
import type { HouseClusters, ScoutingPin } from "@/lib/spread-api";

type Feature = GeoJsonFC["features"][number];

const fc = (features: Feature[]): GeoJsonFC => ({ type: "FeatureCollection", features });

const line = (coordinates: Pt[], properties: Record<string, unknown>): Feature => ({
  type: "Feature",
  properties,
  geometry: { type: "LineString", coordinates },
});

function hullOf(stations: string[], coords: Map<string, Pt>): Pt[] {
  return convexHull(stations.map((s) => coords.get(s)).filter((c): c is Pt => !!c));
}

/** Each patch as a closed hull line over its trees (stroke only, C5). */
export function patchFeatures(clusters: HouseClusters | null, coords: Map<string, Pt>): GeoJsonFC {
  const out: Feature[] = [];
  for (const p of clusters?.clusters ?? []) {
    const hull = hullOf(p.stations, coords);
    if (hull.length >= 2) out.push(line(closedRing(hull), { id: p.id, change: p.change, size: p.size, label: p.label }));
  }
  return fc(out);
}

/** Area pins by the polygon they were drawn as; Patch pins by their trees' hull. */
export function areaPinFeatures(pins: ScoutingPin[], coords: Map<string, Pt>): GeoJsonFC {
  const out: Feature[] = [];
  for (const pin of pins) {
    const ring = pin.polygon?.type === "Polygon" ? ((pin.polygon.coordinates as Pt[][])[0] ?? []) : [];
    if (pin.kind === "Area" && ring.length >= 3) {
      out.push(line(ring, { name: pin.name, title: pin.title }));
    } else if (pin.kind !== "Section") {
      const hull = hullOf(pin.stations, coords);
      if (hull.length >= 2) out.push(line(closedRing(hull), { name: pin.name, title: pin.title }));
    }
  }
  return fc(out);
}

/** The area being drawn: a line from two corners, plus a faint polygon from three. */
export function draftFeatures(vertices: Pt[]): GeoJsonFC {
  if (vertices.length < 2) return fc([]);
  const out: Feature[] = [line(vertices, {})];
  if (vertices.length >= 3) {
    out.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [closedRing(vertices)] } });
  }
  return fc(out);
}
