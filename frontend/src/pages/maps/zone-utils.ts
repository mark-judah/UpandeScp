/**
 * Helpers for working with the cached `getBedsAndZones` payload — used by
 * Heatmaps, Traps and Rose Scouting to position elements at zone polygons
 * or greenhouse centroids.
 */
import type { VarietyNode } from "@/lib/scouting-api";

export interface ZoneFeature {
  zoneName: string;
  bedName: string;
  variety: string;
  /** raw_geojson is parsed lazily — many rows have it stored as a string. */
  geometry: any | null;
}

/**
 * Flatten the variety→bed→zone tree into a list of zone features keyed by
 * zone name. Filters out zones missing geometry.
 */
export function flattenZones(varieties: VarietyNode[]): ZoneFeature[] {
  const out: ZoneFeature[] = [];
  for (const v of varieties) {
    for (const b of v.beds) {
      for (const z of b.zones) {
        let geometry: any = null;
        if (z.raw_geojson) {
          try {
            geometry = typeof z.raw_geojson === "string" ? JSON.parse(z.raw_geojson) : z.raw_geojson;
          } catch {
            geometry = null;
          }
        }
        out.push({
          zoneName: z.name,
          bedName: b.name,
          variety: v.variety,
          geometry,
        });
      }
    }
  }
  return out;
}

/**
 * Compute the [lat, lng] centroid of a Polygon / MultiPolygon. Returns null
 * if the geometry is missing or unrecognised.
 */
export function geometryCentroid(geom: any): [number, number] | null {
  if (!geom) return null;
  let coords: number[][] = [];
  if (geom.type === "Polygon") coords = geom.coordinates?.[0] || [];
  else if (geom.type === "MultiPolygon")
    coords = geom.coordinates?.[0]?.[0] || [];
  else if (geom.type === "Point") {
    const c = geom.coordinates;
    return c && c.length >= 2 ? [c[1], c[0]] : null;
  } else return null;

  if (!coords.length) return null;
  let lat = 0;
  let lng = 0;
  for (const c of coords) {
    lng += c[0];
    lat += c[1];
  }
  return [lat / coords.length, lng / coords.length];
}

/**
 * Greenhouse → centroid. Greenhouse is inferred from the bed name prefix
 * (e.g. ``"Chepsito GH 02 - KR - Bed 14"`` → ``"Chepsito GH 02 - KR"``).
 * Falls back to the bed name if no `` - Bed `` separator is present.
 */
export function greenhouseCentroids(
  zones: ZoneFeature[],
): Record<string, [number, number]> {
  const acc: Record<string, { lat: number; lng: number; n: number }> = {};
  for (const z of zones) {
    const c = geometryCentroid(z.geometry);
    if (!c) continue;
    const idx = z.bedName.indexOf(" - Bed ");
    const gh = idx >= 0 ? z.bedName.slice(0, idx) : z.bedName;
    if (!acc[gh]) acc[gh] = { lat: 0, lng: 0, n: 0 };
    acc[gh].lat += c[0];
    acc[gh].lng += c[1];
    acc[gh].n += 1;
  }
  const out: Record<string, [number, number]> = {};
  Object.entries(acc).forEach(([gh, v]) => {
    if (v.n) out[gh] = [v.lat / v.n, v.lng / v.n];
  });
  return out;
}
