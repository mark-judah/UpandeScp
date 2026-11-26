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
import type { ScoutingEntry } from "@/lib/scouting-types";
import { POINT_PREFIX, entryPoint, unitKey } from "@/lib/unit-key";

export const TRI_ZOOM = 15.5;
/** Big farms (more triangles than FULL_LOAD_MAX_TRIADS): triangles only this close, so no more
 *  than a few blocks' worth is ever in the map at once; the Hexa outlines still come at 16.5. */
export const BIG_TRI_ZOOM = 17.5;
export const TRI_LINE_ZOOM = 18;
export const HEXA_LINE_ZOOM = 16.5;
export const POINT_ZOOM = 14;
/** The unscouted triangle tone. */
export const UNSCOUTED_TRI = "#d8d3c4";

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

/** Add the source once. An existing one keeps its data (re-setting it would blank its layers
 *  until the worker re-tiles: the "hexas vanish" flicker); callers replace data explicitly. */
function ensureSource(map: maplibregl.Map, id: string, data: unknown, extra: Record<string, unknown> = {}) {
  if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: data as never, ...extra } as never);
}

/** Add (once) the triangle, Hexa-outline and point layers under the block outline. */
export function addFieldLayers(map: maplibregl.Map, tri: { fc: unknown }, hexaLines: GeoJsonFC, triBlocks: string[]): void {
  const before = map.getLayer("blocks-line") ? "blocks-line" : undefined;
  if (!map.getSource("fg-tri")) {
    map.addSource("fg-tri", { type: "geojson", data: tri.fc as never, tolerance: 0, buffer: 32, maxzoom: 20 } as never);
    map.addLayer(
      {
        id: "fg-tri-fill",
        type: "fill",
        source: "fg-tri",
        minzoom: TRI_ZOOM - FADE_DZ,
        paint: {
          "fill-color": ["coalesce", ["feature-state", "c"], UNSCOUTED_TRI] as never,
          "fill-opacity": triFillOpacity(TRI_ZOOM) as never,
        },
      },
      before,
    );
    map.addLayer(
      {
        id: "fg-tri-line",
        type: "line",
        source: "fg-tri",
        minzoom: TRI_LINE_ZOOM - FADE_DZ,
        paint: { "line-color": "#2a2a26", "line-width": 0.5, "line-opacity": fadeIn(TRI_LINE_ZOOM, 0.35) as never },
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
        minzoom: HEXA_LINE_ZOOM - FADE_DZ,
        paint: { "line-color": "#2a2a26", "line-width": 1, "line-opacity": fadeIn(HEXA_LINE_ZOOM, 0.55) as never },
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
          "fill-opacity": heatTriOpacity(TRI_ZOOM) as never,
        },
      },
      "blocks-line",
    );
  }
}

/** Colour the triangles and blocks from the view's per-unit colours (touching only what changed). */
export function paintFieldColors(
  map: maplibregl.Map,
  tri: { idByName: Map<string, number> },
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

/** Layers fade in over the half zoom before their threshold instead of popping in at it. */
export const FADE_DZ = 0.5;

/** 0 at ``z - FADE_DZ``, ``to`` at ``z`` (a zoom ramp; MapLibre needs it at the top level). */
export function fadeIn(z: number, to: number) {
  return ["interpolate", ["linear"], ["zoom"], z - FADE_DZ, 0, z, to];
}

/** Visited triangles strong, unscouted faint, both ramping in over the fade. */
export function triFillOpacity(triZoom: number, unscouted = 0.28) {
  const visited = ["to-boolean", ["feature-state", "c"]];
  return ["interpolate", ["linear"], ["zoom"], triZoom - FADE_DZ, 0, triZoom, ["case", visited, 0.88, unscouted]];
}

function heatTriOpacity(triZoom: number) {
  return ["interpolate", ["linear"], ["zoom"], 14, 0.5, triZoom - FADE_DZ, 0.45, triZoom + 0.5, 0];
}

/** Move where the triangles start (15.5 for a small farm, BIG_TRI_ZOOM for a big one). */
export function setFieldTriZoom(map: maplibregl.Map, triZoom: number, unscouted = 0.28): void {
  const lineZoom = Math.max(TRI_LINE_ZOOM, triZoom);
  if (map.getLayer("fg-tri-fill")) {
    map.setLayerZoomRange("fg-tri-fill", triZoom - FADE_DZ, 24);
    map.setPaintProperty("fg-tri-fill", "fill-opacity", triFillOpacity(triZoom, unscouted) as never);
  }
  if (map.getLayer("fg-tri-line")) {
    map.setLayerZoomRange("fg-tri-line", lineZoom - FADE_DZ, 24);
    map.setPaintProperty("fg-tri-line", "line-opacity", fadeIn(lineZoom, 0.35) as never);
  }
  if (map.getLayer("blocks-heat-tri")) map.setPaintProperty("blocks-heat-tri", "fill-opacity", heatTriOpacity(triZoom) as never);
}

/** Which blocks have triangles (their block wash fades as the triangles come in). */
export function setFieldTriBlocks(map: maplibregl.Map, triBlocks: string[]): void {
  const triIn = ["in", ["get", "block"], ["literal", triBlocks]] as never;
  if (map.getLayer("blocks-heat")) map.setFilter("blocks-heat", ["!", triIn] as never);
  if (map.getLayer("blocks-heat-tri")) map.setFilter("blocks-heat-tri", triIn);
}

/** Replace what the triangle and Hexa sources hold (null = leave that one as it is). */
export function setFieldData(map: maplibregl.Map, tri: unknown | null, hexa: unknown | null): void {
  if (tri) (map.getSource("fg-tri") as maplibregl.GeoJSONSource | undefined)?.setData(tri as never);
  if (hexa) (map.getSource("fg-hexa") as maplibregl.GeoJSONSource | undefined)?.setData(hexa as never);
}

/** Distinct trees and triangles that carry a colour, counted on the shown blocks only. Pure. */
export function visitedUnits(
  entries: ScoutingEntry[],
  colors: Map<string, string>,
  onBlock?: (block: string) => boolean,
): { trees: number; triads: number } {
  const trees = new Set<string>();
  const triads = new Set<string>();
  for (const e of entries) {
    if (onBlock && !onBlock(e.block || "")) continue;
    if (e.tree) {
      if (colors.has(e.tree)) trees.add(e.tree);
    } else if (e.triad && colors.has(e.triad)) triads.add(e.triad);
  }
  return { trees: trees.size, triads: triads.size };
}

/* ---------- the whole farm, one source per chunk ---------- */

export const CHUNK_PREFIX = "fg-c-";

/** The triangle / triangle-outline / Hexa-outline layers of every chunk on the map. */
export function chunkLayerIds(map: maplibregl.Map): { fill: string[]; line: string[]; hexa: string[] } {
  const ids = (map.getStyle()?.layers ?? []).map((l) => l.id).filter((id) => id.startsWith(CHUNK_PREFIX));
  return {
    fill: ids.filter((id) => id.endsWith("-fill")),
    line: ids.filter((id) => id.endsWith("-tline")),
    hexa: ids.filter((id) => id.endsWith("-hexa")),
  };
}

/**
 * Add one chunk of the farm (``data``: a GeoJSON object or a URL, e.g. a blob URL of the text
 * from chunkGeojsonText) as its own source with its three layers, under the block outline. The
 * source is never re-set: a loaded chunk stays tiled, and zooming or panning fetches nothing.
 */
export function addFieldChunk(map: maplibregl.Map, key: string, data: unknown, triZoom: number, visible: { tri: boolean; hexa: boolean }, unscouted = 0.28): string {
  const id = `${CHUNK_PREFIX}${key}`;
  if (map.getSource(id)) return id;
  // maxzoom 18: tiles cut at 18 are exact to ~2 cm and overzoom to 19-20, so no deeper tiling;
  // tolerance 0: triangles are already minimal; a small buffer: fewer duplicated edges.
  map.addSource(id, { type: "geojson", data: data as never, tolerance: 0, buffer: 8, maxzoom: 18 } as never);
  const before = map.getLayer("blocks-line") ? "blocks-line" : undefined;
  const isTri = ["!", ["has", "k"]] as never;
  const isHexa = ["has", "k"] as never;
  const lineZoom = Math.max(TRI_LINE_ZOOM, triZoom);
  const vis = (on: boolean) => ({ visibility: on ? "visible" : "none" }) as never;
  map.addLayer(
    {
      id: `${id}-fill`,
      type: "fill",
      source: id,
      filter: isTri,
      minzoom: triZoom - FADE_DZ,
      layout: vis(visible.tri),
      paint: {
        "fill-color": ["coalesce", ["feature-state", "c"], UNSCOUTED_TRI] as never,
        "fill-opacity": triFillOpacity(triZoom, unscouted) as never,
      },
    },
    before,
  );
  map.addLayer(
    {
      id: `${id}-tline`,
      type: "line",
      source: id,
      filter: isTri,
      minzoom: lineZoom - FADE_DZ,
      layout: vis(visible.tri),
      paint: { "line-color": "#2a2a26", "line-width": 0.5, "line-opacity": fadeIn(lineZoom, 0.35) as never },
    },
    before,
  );
  map.addLayer(
    {
      id: `${id}-hexa`,
      type: "line",
      source: id,
      filter: isHexa,
      minzoom: HEXA_LINE_ZOOM - FADE_DZ,
      layout: vis(visible.hexa),
      paint: { "line-color": "#2a2a26", "line-width": 1, "line-opacity": fadeIn(HEXA_LINE_ZOOM, 0.55) as never },
    },
    before,
  );
  return id;
}

/** Remove every chunk (another farm picked). */
export function removeFieldChunks(map: maplibregl.Map): void {
  const { fill, line, hexa } = chunkLayerIds(map);
  for (const id of [...fill, ...line, ...hexa]) map.removeLayer(id);
  for (const id of Object.keys(map.getStyle()?.sources ?? {})) if (id.startsWith(CHUNK_PREFIX)) map.removeSource(id);
}

export function setChunkVisibility(map: maplibregl.Map, v: { tri: boolean; hexa: boolean }): void {
  const { fill, line, hexa } = chunkLayerIds(map);
  for (const id of [...fill, ...line]) map.setLayoutProperty(id, "visibility", v.tri ? "visible" : "none");
  for (const id of hexa) map.setLayoutProperty(id, "visibility", v.hexa ? "visible" : "none");
}

/** Where a triad is drawn: a GPU instance of the lattice layer, or a feature of an edge-piece
 *  source (see lib/field-geo FarmLattice.lookup). */
export type TriadPlace = { kind: "inst"; held: unknown; i: number } | { kind: "clip"; source: string; id: number };

/** Colour triads by name, touching only what changed: instance colours in the lattice layer,
 *  feature-state on edge pieces. Names not loaded yet are skipped; call again with ``prev`` null
 *  for a newly loaded part. */
export function paintLatticeColors(
  map: maplibregl.Map,
  lookup: (name: string) => TriadPlace | null,
  setInstance: (held: unknown, i: number, color: string | null) => void,
  prev: Map<string, string> | null,
  next: Map<string, string>,
): void {
  const { set, clear } = diffColors(prev, next, () => true);
  const apply = (k: string, c: string | null) => {
    const at = lookup(k);
    if (!at) return;
    if (at.kind === "inst") setInstance(at.held, at.i, c);
    else if (map.getSource(at.source)) {
      if (c) map.setFeatureState({ source: at.source, id: at.id }, { c });
      else map.removeFeatureState({ source: at.source, id: at.id }, "c");
    }
  };
  for (const k of clear) apply(k, null);
  for (const [k, c] of set) apply(k, c);
}
