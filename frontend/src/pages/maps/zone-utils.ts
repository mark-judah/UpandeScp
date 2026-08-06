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
  /** Synthesised directly from the decoded ``coords``/``lineId`` pair — a
   *  FeatureCollection with the zone's single bed-line LineString feature,
   *  the same shape ``raw_geojson`` used to carry (see below). No JSON
   *  parsing happens here: it's built straight from already-typed arrays. */
  geometry: any | null;
}

/**
 * Flatten the variety→bed→zone tree into a list of zone features keyed by
 * zone name. Filters out zones missing geometry.
 *
 * Each zone arrives from ``fetchBedsAndZones`` as ``{name, coords, lineId}``
 * (decoded client-side from the compact wire format — see
 * ``upande_scp.serverscripts.geo.zone_encoding``). Consumers of
 * ``ZoneFeature.geometry`` (Leaflet's ``L.geoJSON``, ``geometryCentroid``,
 * ``zonePolygonFromGeometry``) still expect a GeoJSON shape, so this
 * synthesises the equivalent single-feature FeatureCollection the old
 * ``raw_geojson`` string decoded to — but directly from typed arrays,
 * never via ``JSON.parse``.
 */
export function flattenZones(varieties: VarietyNode[]): ZoneFeature[] {
  const out: ZoneFeature[] = [];
  for (const v of varieties) {
    for (const b of v.beds) {
      for (const z of b.zones) {
        let geometry: any = null;
        if (Array.isArray(z.coords) && z.coords.length === 2) {
          geometry = {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: { type: "LineString", coordinates: z.coords },
                properties: { line_id: z.lineId },
              },
            ],
          };
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
 * Compute the [lat, lng] centroid of a Polygon / MultiPolygon /
 * FeatureCollection-of-LineStrings. Returns null if the geometry is
 * missing or unrecognised.
 *
 * Zones in the bed/zone payload arrive as FeatureCollections of LineString
 * features (one per bed-line in the zone) — the LineString case averages
 * every vertex across every feature so the centroid sits in the middle of
 * the entire zone, not just one of its lines.
 */
export function geometryCentroid(geom: any): [number, number] | null {
  if (!geom) return null;

  // FeatureCollection — average across every feature's coordinates.
  if (geom.type === "FeatureCollection" && Array.isArray(geom.features)) {
    let lat = 0;
    let lng = 0;
    let n = 0;
    for (const f of geom.features) {
      const g = f?.geometry;
      if (!g) continue;
      if (g.type === "LineString" && Array.isArray(g.coordinates)) {
        for (const c of g.coordinates) {
          lng += c[0];
          lat += c[1];
          n += 1;
        }
      } else if (g.type === "Polygon" && Array.isArray(g.coordinates?.[0])) {
        for (const c of g.coordinates[0]) {
          lng += c[0];
          lat += c[1];
          n += 1;
        }
      }
    }
    return n ? [lat / n, lng / n] : null;
  }

  let coords: number[][] = [];
  if (geom.type === "Polygon") coords = geom.coordinates?.[0] || [];
  else if (geom.type === "MultiPolygon")
    coords = geom.coordinates?.[0]?.[0] || [];
  else if (geom.type === "LineString")
    coords = (geom.coordinates as number[][]) || [];
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
 * Build a closed `Polygon` GeoJSON geometry from a zone's
 * FeatureCollection-of-LineStrings — i.e. the same trick the legacy
 * observations_map page uses (``getZoneCoords`` + ring-close) to draw a
 * leaflet polygon with a fill colour. Returns null when the geometry is
 * unusable (no points, single point, etc.).
 */
export function zonePolygonFromGeometry(geom: any): any | null {
  if (!geom) return null;
  // Already a polygon — pass through.
  if (geom.type === "Polygon" || geom.type === "MultiPolygon") return geom;

  const ring: number[][] = [];
  if (geom.type === "LineString" && Array.isArray(geom.coordinates)) {
    for (const c of geom.coordinates) ring.push([c[0], c[1]]);
  } else if (
    geom.type === "FeatureCollection" &&
    Array.isArray(geom.features)
  ) {
    for (const f of geom.features) {
      const g = f?.geometry;
      if (!g) continue;
      if (g.type === "LineString" && Array.isArray(g.coordinates)) {
        for (const c of g.coordinates) ring.push([c[0], c[1]]);
      }
    }
  }
  if (ring.length < 3) return null;
  // Close the ring if needed.
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
  return { type: "Polygon", coordinates: [ring] };
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
