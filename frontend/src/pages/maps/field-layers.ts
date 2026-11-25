/**
 * MapLibre layers for blocks that are surveyed into Hexas and triangles (Triads).
 *
 * Everything the browser draws here comes from lib/field-geo.ts: one GeoJSON source for all
 * triangles (MapLibre tiles and parses it in its worker, and only what is in view is drawn), the
 * Hexa outlines, and a point source for visits on blocks that have an outline but no triangles.
 * The triangle fill appears from TRI_ZOOM, the Hexa outline from HEXA_LINE_ZOOM and the triangle
 * outline from TRI_LINE_ZOOM; below that only the block boundaries paint, so zooming out never
 * pays for tens of thousands of polygons. Colour is feature-state (set per triangle / per
 * block, never by rebuilding geometry).
 */
import type maplibregl from "maplibre-gl";
import type { GeoJsonFC } from "@/lib/scouting-api";
import type { TriadSet } from "@/lib/field-geo";
import type { ScoutingEntry } from "@/lib/scouting-types";
import { POINT_PREFIX, entryPoint, unitKey } from "@/lib/unit-key";

export const TRI_ZOOM = 15.5;
export const TRI_LINE_ZOOM = 18;
export const HEXA_LINE_ZOOM = 16.5;
export const POINT_ZOOM = 14;
const UNSCOUTED_TRI = "#d8d3c4";

export const FG_LAYERS = ["fg-tri-fill", "fg-tri-line", "fg-hexa-line", "fg-pts", "blocks-heat", "blocks-heat-tri"] as const;

/** Which names changed colour, so a recolour touches only what changed. Pure. */
export function diffColors(
  prev: Map<string, string> | null,
  next: Map<string, string>,
  known: (k: string) => boolean,
): { set: Array<[string, string]>; clear: string[] } {
  const set: Array<[string, string]> = [];
  const clear: string[] = [];
  for (const [k, c] of next) {
    if (!known(k)) continue;
    if (prev?.get(k) !== c) set.push([k, c]);
  }
  if (prev) for (const k of prev.keys()) if (known(k) && !next.has(k)) clear.push(k);
  return { set, clear };
}

/** Each block's colour: the colour most of its coloured visits share. Pure. */
export function blockColors(entries: ScoutingEntry[], colors: Map<string, string>): Map<string, string> {
  const tally = new Map<string, Map<string, number>>();
  for (const e of entries) {
    if (!e.block) continue;
    const c = colors.get(unitKey(e));
    if (!c) continue;
    let t = tally.get(e.block);
    if (!t) tally.set(e.block, (t = new Map()));
    t.set(c, (t.get(c) || 0) + 1);
  }
  const out = new Map<string, string>();
  for (const [block, t] of tally) {
    let best = "";
    let n = -1;
    for (const [c, k] of t) if (k > n) (n = k), (best = c);
    out.set(block, best);
  }
  return out;
}

/** Visit points for blocks with no triangles or trees: one coloured dot per located visit. Pure. */
export function pointFeatures(entries: ScoutingEntry[], colors: Map<string, string>): GeoJsonFC {
  const features: GeoJsonFC["features"] = [];
  for (const e of entries) {
    const key = unitKey(e);
    if (!key.startsWith(POINT_PREFIX)) continue;
    const c = colors.get(key);
    const p = entryPoint(e);
    if (!c || !p) continue;
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { c, block: e.block } });
  }
  return { type: "FeatureCollection", features };
}

function ensureSource(map: maplibregl.Map, id: string, data: unknown, extra: Record<string, unknown> = {}) {
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(data as never);
  else map.addSource(id, { type: "geojson", data: data as never, ...extra } as never);
}

/** Add (once) the triangle, Hexa-outline and point layers under the block outline. */
export function addFieldLayers(map: maplibregl.Map, tri: TriadSet, hexaLines: GeoJsonFC, triBlocks: string[]): void {
  const before = map.getLayer("blocks-line") ? "blocks-line" : undefined;
  if (!map.getSource("fg-tri")) {
    map.addSource("fg-tri", { type: "geojson", data: tri.fc as never, tolerance: 0, buffer: 32, maxzoom: 20 } as never);
    map.addLayer(
      {
        id: "fg-tri-fill",
        type: "fill",
        source: "fg-tri",
        minzoom: TRI_ZOOM,
        paint: {
          "fill-color": ["coalesce", ["feature-state", "c"], UNSCOUTED_TRI] as never,
          "fill-opacity": ["case", ["to-boolean", ["feature-state", "c"]], 0.88, 0.28] as never,
        },
      },
      before,
    );
    map.addLayer(
      {
        id: "fg-tri-line",
        type: "line",
        source: "fg-tri",
        minzoom: TRI_LINE_ZOOM,
        paint: { "line-color": "#2a2a26", "line-width": 0.5, "line-opacity": 0.35 },
      },
      before,
    );
  }
  ensureSource(map, "fg-hexa", hexaLines);
  if (!map.getLayer("fg-hexa-line")) {
    map.addLayer(
      {
        id: "fg-hexa-line",
        type: "line",
        source: "fg-hexa",
        minzoom: HEXA_LINE_ZOOM,
        paint: { "line-color": "#2a2a26", "line-width": 1, "line-opacity": 0.55 },
      },
      before,
    );
  }
  ensureSource(map, "fg-pts", { type: "FeatureCollection", features: [] });
  if (!map.getLayer("fg-pts")) {
    map.addLayer({
      id: "fg-pts",
      type: "circle",
      source: "fg-pts",
      minzoom: POINT_ZOOM,
      paint: {
        "circle-color": ["get", "c"] as never,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 1.8, 17, 4, 20, 8] as never,
        "circle-opacity": 0.78,
        "circle-stroke-width": 0.5,
        "circle-stroke-color": "#ffffff",
      },
    });
  }
  // Block colour wash: blocks that have triangles fade it out as the triangles come in.
  if (map.getSource("blocks") && !map.getLayer("blocks-heat")) {
    const triIn = ["in", ["get", "block"], ["literal", triBlocks]] as never;
    const colour = ["coalesce", ["feature-state", "c"], "rgba(0,0,0,0)"] as never;
    map.addLayer(
      {
        id: "blocks-heat",
        type: "fill",
        source: "blocks",
        filter: ["!", triIn] as never,
        paint: { "fill-color": colour, "fill-opacity": 0.4 },
      },
      "blocks-line",
    );
    map.addLayer(
      {
        id: "blocks-heat-tri",
        type: "fill",
        source: "blocks",
        filter: triIn,
        paint: {
          "fill-color": colour,
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0.5, TRI_ZOOM, 0.45, TRI_ZOOM + 1.2, 0] as never,
        },
      },
      "blocks-line",
    );
  }
}

/** Colour the triangles and blocks from the view's per-unit colours (touching only what changed). */
export function paintFieldColors(
  map: maplibregl.Map,
  tri: TriadSet,
  prev: Map<string, string> | null,
  next: Map<string, string>,
  perBlock: { prev: Map<string, string> | null; next: Map<string, string> },
): void {
  if (map.getSource("fg-tri")) {
    const { set, clear } = diffColors(prev, next, (k) => tri.idByName.has(k));
    for (const k of clear) map.removeFeatureState({ source: "fg-tri", id: tri.idByName.get(k)! }, "c");
    for (const [k, c] of set) map.setFeatureState({ source: "fg-tri", id: tri.idByName.get(k)! }, { c });
  }
  if (map.getSource("blocks")) {
    const { set, clear } = diffColors(perBlock.prev, perBlock.next, () => true);
    for (const b of clear) map.removeFeatureState({ source: "blocks", id: b }, "c");
    for (const [b, c] of set) map.setFeatureState({ source: "blocks", id: b }, { c });
  }
}

export function setFieldVisibility(map: maplibregl.Map, v: { tri: boolean; hexa: boolean }): void {
  const set = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  set("fg-tri-fill", v.tri);
  set("fg-tri-line", v.tri);
  set("fg-hexa-line", v.hexa);
}
