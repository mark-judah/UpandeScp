/**
 * MapLibre layers for blocks that are surveyed into rows and hexagons (Triads).
 *
 * Everything the browser draws here comes from lib/field-geo.ts: one GeoJSON source for all
 * hexagons (MapLibre tiles and parses it in its worker, and only what is in view is drawn), row
 * lines, and a point source for visits on blocks that have an outline but no hexagons. The
 * hexagon fill appears from HEX_ZOOM and its outline from HEX_LINE_ZOOM; below that only the
 * block boundaries paint, so zooming out never pays for 24,000 polygons. Colour is feature-state
 * (set per hexagon / per block, never by rebuilding geometry).
 */
import type maplibregl from "maplibre-gl";
import type { GeoJsonFC } from "@/lib/scouting-api";
import type { HexSet } from "@/lib/field-geo";
import type { ScoutingEntry } from "@/lib/scouting-types";
import { POINT_PREFIX, entryPoint, unitKey } from "@/lib/unit-key";

export const HEX_ZOOM = 15.5;
export const HEX_LINE_ZOOM = 17.2;
export const ROW_ZOOM = 16;
export const POINT_ZOOM = 14;
const UNSCOUTED_HEX = "#d8d3c4";

export const FG_LAYERS = ["fg-hex-fill", "fg-hex-line", "fg-rows", "fg-pts", "blocks-heat", "blocks-heat-hex"] as const;

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

/** Visit points for blocks with no hexagons or trees: one coloured dot per located visit. Pure. */
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

/** Add (once) the hexagon, row and point layers under the block outline. */
export function addFieldLayers(map: maplibregl.Map, hex: HexSet, rows: GeoJsonFC, hexBlocks: string[]): void {
  const before = map.getLayer("blocks-line") ? "blocks-line" : undefined;
  if (!map.getSource("fg-hex")) {
    map.addSource("fg-hex", { type: "geojson", data: hex.fc as never, tolerance: 0, buffer: 32, maxzoom: 19 } as never);
    map.addLayer(
      {
        id: "fg-hex-fill",
        type: "fill",
        source: "fg-hex",
        minzoom: HEX_ZOOM,
        paint: {
          "fill-color": ["coalesce", ["feature-state", "c"], UNSCOUTED_HEX] as never,
          "fill-opacity": ["case", ["to-boolean", ["feature-state", "c"]], 0.88, 0.28] as never,
        },
      },
      before,
    );
    map.addLayer(
      {
        id: "fg-hex-line",
        type: "line",
        source: "fg-hex",
        minzoom: HEX_LINE_ZOOM,
        paint: { "line-color": "#2a2a26", "line-width": 0.5, "line-opacity": 0.35 },
      },
      before,
    );
  }
  ensureSource(map, "fg-rows", rows);
  if (!map.getLayer("fg-rows")) {
    map.addLayer(
      {
        id: "fg-rows",
        type: "line",
        source: "fg-rows",
        minzoom: ROW_ZOOM,
        paint: { "line-color": "#6b705c", "line-width": 1, "line-opacity": 0.5, "line-dasharray": [2, 2] },
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
  // Block colour wash: blocks that have hexagons fade it out as the hexagons come in.
  if (map.getSource("blocks") && !map.getLayer("blocks-heat")) {
    const hexIn = ["in", ["get", "block"], ["literal", hexBlocks]] as never;
    const colour = ["coalesce", ["feature-state", "c"], "rgba(0,0,0,0)"] as never;
    map.addLayer(
      {
        id: "blocks-heat",
        type: "fill",
        source: "blocks",
        filter: ["!", hexIn] as never,
        paint: { "fill-color": colour, "fill-opacity": 0.4 },
      },
      "blocks-line",
    );
    map.addLayer(
      {
        id: "blocks-heat-hex",
        type: "fill",
        source: "blocks",
        filter: hexIn,
        paint: {
          "fill-color": colour,
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0.5, HEX_ZOOM, 0.45, HEX_ZOOM + 1.2, 0] as never,
        },
      },
      "blocks-line",
    );
  }
}

/** Colour the hexagons and blocks from the view's per-unit colours (touching only what changed). */
export function paintFieldColors(
  map: maplibregl.Map,
  hex: HexSet,
  prev: Map<string, string> | null,
  next: Map<string, string>,
  perBlock: { prev: Map<string, string> | null; next: Map<string, string> },
): void {
  if (map.getSource("fg-hex")) {
    const { set, clear } = diffColors(prev, next, (k) => hex.idByName.has(k));
    for (const k of clear) map.removeFeatureState({ source: "fg-hex", id: hex.idByName.get(k)! }, "c");
    for (const [k, c] of set) map.setFeatureState({ source: "fg-hex", id: hex.idByName.get(k)! }, { c });
  }
  if (map.getSource("blocks")) {
    const { set, clear } = diffColors(perBlock.prev, perBlock.next, () => true);
    for (const b of clear) map.removeFeatureState({ source: "blocks", id: b }, "c");
    for (const [b, c] of set) map.setFeatureState({ source: "blocks", id: b }, { c });
  }
}

export function setFieldVisibility(map: maplibregl.Map, v: { hex: boolean; rows: boolean }): void {
  const set = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  set("fg-hex-fill", v.hex);
  set("fg-hex-line", v.hex);
  set("fg-rows", v.rows);
}
