/**
 * The block-grown crops' Hexas and triangles on a MapLibre map, as the lattice they were cut on.
 *
 * Shared by the avocado scouting map and the Application Floor Plan. The browser first gets an
 * index (how many triangles each block has), then every block's lattice, nearest the view first,
 * a chunk at a time in the background. Full triangles and Hexa outlines go to one GPU instanced
 * layer (FieldLatticeLayer: a few bytes per triangle, no per-triangle GeoJSON); the clipped edge
 * pieces (about a tenth) to a small GeoJSON source per chunk. Nothing is dropped while the farm
 * stays picked, so once it is in, zooming and panning fetch nothing.
 */
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import maplibregl from "maplibre-gl";
import {
  FULL_LOAD_MAX_TRIADS,
  FarmLattice,
  StaleFieldIndex,
  chunkBlocks,
  edgePiecesGeojsonText,
  fetchFieldIndex,
  geometryBBox,
  loadLatticeBlocks,
  prefetchFarmLattice,
  resetFieldIndexCache,
  type BBox,
  type FieldIndex,
  type HeldLattice,
} from "@/lib/field-geo";
import type { GeoJsonFC } from "@/lib/scouting-api";
import type { ScoutingEntry } from "@/lib/scouting-types";
import { FieldLatticeLayer, LATTICE_LAYER_ID } from "./FieldLatticeLayer";
import {
  BIG_TRI_ZOOM,
  CHUNK_PREFIX,
  FADE_DZ,
  HEXA_LINE_ZOOM,
  TRI_ZOOM,
  addFieldChunk,
  addFieldLayers,
  paintFieldColors,
  paintLatticeColors,
  pointFeatures,
  removeFieldChunks,
  setChunkVisibility,
  setFieldTriBlocks,
  setFieldTriZoom,
  setFieldVisibility,
} from "./field-layers";
import { warmBasemapTiles } from "./warm-basemap";

/** Blocks per lattice request (the server takes at most 80). */
const REQUEST_BLOCKS = 60;
const EMPTY_FC = { type: "FeatureCollection" as const, features: [] as never[] };

export interface FieldLatticeOptions {
  mapRef: MutableRefObject<maplibregl.Map | null>;
  mapReady: boolean;
  blocks: GeoJsonFC | null;
  /** "" = all farms */
  farmKey: string;
  /** from useFieldIndex */
  index: FieldIndex | null;
  /** the server's data changed under us: ask useFieldIndex to reload */
  onStale: () => void;
  /** triad name -> colour */
  colors: Map<string, string>;
  /** block -> colour (the wash under the triangles / on blocks without any) */
  perBlock: Map<string, string>;
  /** visits drawn as dots on blocks that have an outline but no triangles */
  pointEntries: ScoutingEntry[];
  showTri: boolean;
  showHexa: boolean;
  /** false: a triangle with no finding is not filled at all (only findings show) */
  unscoutedFill?: boolean;
}

export interface FieldLattice {
  /** background load progress, null when done / nothing to load */
  load: { done: number; total: number } | null;
  /** every chunk is in */
  ready: boolean;
  /** blocks that have triangles */
  triBlocks: string[];
  triZoom: number;
  lattice: FarmLattice;
  /** The triad under a point, by lattice maths. */
  pick: (lng: number, lat: number, block?: string) => string | null;
  centroid: (name: string) => [number, number] | null;
}

/** The farm's per-block triangle counts (no geometry), off the critical path, and the start of
 *  the farm's lattice download. ``farmSettled`` is false while the farm is still being decided
 *  (no "All farms" fetch first). */
export function useFieldIndex(farmKey: string, farmSettled = true): { index: FieldIndex | null; refresh: () => void } {
  const [index, setIndex] = useState<FieldIndex | null>(null);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (!farmSettled) return;
    let alive = true;
    setIndex(null);
    fetchFieldIndex(farmKey)
      .then((r) => {
        if (!alive) return;
        // The geometry download starts now, not once the map is up: it overlaps the map's
        // start-up (WebGL context, shader compiles) and the other page requests.
        prefetchFarmLattice(farmKey, r);
        setIndex(r);
      })
      .catch(() => alive && setIndex(null));
    return () => {
      alive = false;
    };
  }, [farmKey, farmSettled, epoch]);
  return { index, refresh: () => setEpoch((n) => n + 1) };
}

export function useFieldLattice(o: FieldLatticeOptions): FieldLattice {
  const { mapRef, mapReady, blocks, farmKey, index, colors, perBlock, pointEntries, showTri, showHexa } = o;
  const unscouted = o.unscoutedFill === false ? 0 : 0.28;
  const [load, setLoad] = useState<{ done: number; total: number } | null>(null);
  const [ready, setReady] = useState(false);
  const onStaleRef = useRef(o.onStale);
  onStaleRef.current = o.onStale;
  const latticeRef = useRef<FarmLattice>(new FarmLattice());
  const layerRef = useRef<FieldLatticeLayer | null>(null);
  const paintedRef = useRef<{ units: Map<string, string> | null; blocks: Map<string, string> | null }>({ units: null, blocks: null });
  const visRef = useRef({ tri: showTri, hexa: showHexa });
  visRef.current = { tri: showTri, hexa: showHexa };
  const colorsRef = useRef(colors);
  colorsRef.current = colors;

  const big = (index?.triads ?? 0) > FULL_LOAD_MAX_TRIADS;
  const triZoom = big ? BIG_TRI_ZOOM : TRI_ZOOM;
  const triBlocks = useMemo(() => Object.entries(index?.counts ?? {}).filter(([, c]) => c[0] > 0).map(([b]) => b), [index]);
  const blockBoxes = useMemo(() => {
    const m = new Map<string, BBox>();
    const want = new Set(triBlocks);
    for (const f of blocks?.features ?? []) {
      const b = String(f.properties?.block ?? "");
      if (!want.has(b)) continue;
      const box = geometryBBox(f.geometry as never);
      if (!box) continue;
      const had = m.get(b);
      m.set(b, had ? [Math.min(had[0], box[0]), Math.min(had[1], box[1]), Math.max(had[2], box[2]), Math.max(had[3], box[3])] : box);
    }
    return m;
  }, [blocks, triBlocks]);

  const setInstance = (held: unknown, i: number, c: string | null) => layerRef.current?.setColor(held as HeldLattice, i, c);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !blocks || !index) return;
    addFieldLayers(map, { fc: EMPTY_FC }, EMPTY_FC, triBlocks); // visit points + block wash
    setFieldTriBlocks(map, triBlocks);
    setFieldTriZoom(map, triZoom, unscouted);
    setFieldVisibility(map, visRef.current);
    removeFieldChunks(map);
    if (map.getLayer(LATTICE_LAYER_ID)) map.removeLayer(LATTICE_LAYER_ID);
    const field = (latticeRef.current = new FarmLattice());
    const layer = (layerRef.current = new FieldLatticeLayer(triZoom, undefined, unscouted));
    layer.setVisible(visRef.current);
    map.addLayer(layer, map.getLayer("blocks-line") ? "blocks-line" : undefined);
    paintedRef.current = { units: null, blocks: null };
    setReady(false);
    const c = map.getCenter();
    const dist = (b: string) => {
      const x = blockBoxes.get(b);
      if (!x) return Infinity;
      const dx = Math.max(x[0] - c.lng, 0, c.lng - x[2]);
      const dy = Math.max(x[1] - c.lat, 0, c.lat - x[3]);
      return dx * dx + dy * dy;
    };
    const order = [...triBlocks].sort((a, b) => dist(a) - dist(b) || a.localeCompare(b));
    // One request per REQUEST_BLOCKS blocks (the whole of a farm like Mutara in one), each then fed
    // to the GPU in CHUNK_TRIADS-sized pieces so the page paints between them.
    const requests: string[][] = [];
    for (let i = 0; i < order.length; i += REQUEST_BLOCKS) requests.push(order.slice(i, i + REQUEST_BLOCKS));
    const total = order.length;
    setLoad(total ? { done: 0, total } : null);
    if (!total) setReady(true);
    let alive = true;
    const pending = new Map<string, string>(); // source -> blob URL, revoked once loaded
    const onSourceData = (e: maplibregl.MapSourceDataEvent) => {
      const url = pending.get(e.sourceId);
      if (url && e.sourceDataType === "metadata") {
        URL.revokeObjectURL(url);
        pending.delete(e.sourceId);
      }
    };
    map.on("sourcedata", onSourceData);
    (async () => {
      let done = 0;
      let n = 0;
      for (const names of requests) {
        let got: Awaited<ReturnType<typeof loadLatticeBlocks>>;
        try {
          got = await loadLatticeBlocks(farmKey, index.version, names);
        } catch (e) {
          if (!alive) return;
          if (e instanceof StaleFieldIndex) {
            resetFieldIndexCache();
            onStaleRef.current();
          } else setLoad(null);
          return;
        }
        for (const chunk of chunkBlocks(names, index.counts)) {
          if (!alive || mapRef.current !== map) return;
          const source = `${CHUNK_PREFIX}${n++}`;
          const held = chunk.map((b) => field.add(b, got.get(b)!, source));
          layer.addBlocks(held);
          const url = URL.createObjectURL(new Blob([edgePiecesGeojsonText(held)], { type: "application/json" }));
          pending.set(source, url);
          addFieldChunk(map, source.slice(CHUNK_PREFIX.length), url, triZoom, visRef.current, unscouted);
          // Colour this chunk's visited triangles (the rest were coloured as their chunks came).
          const mine = new Set(held);
          const here = new Map(
            [...colorsRef.current].filter(([k]) => {
              const at = field.lookup(k);
              return !!at && (at.kind === "clip" ? at.source === source : mine.has(at.held));
            }),
          );
          paintLatticeColors(map, (nm) => field.lookup(nm), setInstance, null, here);
          layer.repaint();
          done += chunk.length;
          setLoad({ done, total });
          await new Promise((r) => window.setTimeout(r, 0)); // let the page paint between pieces
          if (!alive) return;
        }
      }
      setLoad(null);
      setReady(true);
      // Then the basemap tiles under the farm, so moving around it never waits on them either.
      const box = [...blockBoxes.values()].reduce<BBox | null>(
        (u, x) => (u ? [Math.min(u[0], x[0]), Math.min(u[1], x[1]), Math.max(u[2], x[2]), Math.max(u[3], x[3])] : x),
        null,
      );
      if (box) warmBasemapTiles(map, box);
    })();
    return () => {
      alive = false;
      map.off("sourcedata", onSourceData);
      for (const url of pending.values()) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, blocks, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !map.getSource("fg-tri")) return;
    const field = latticeRef.current;
    paintLatticeColors(map, (n) => field.lookup(n), setInstance, paintedRef.current.units, colors);
    layerRef.current?.repaint();
    paintFieldColors(map, { idByName: new Map() }, null, new Map(), { prev: paintedRef.current.blocks, next: perBlock });
    paintedRef.current = { units: colors, blocks: perBlock };
    (map.getSource("fg-pts") as maplibregl.GeoJSONSource | undefined)?.setData(pointFeatures(pointEntries, colors) as never);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colors, perBlock, pointEntries, index, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    setFieldVisibility(map, { tri: showTri, hexa: showHexa });
    setChunkVisibility(map, { tri: showTri, hexa: showHexa });
    layerRef.current?.setVisible({ tri: showTri, hexa: showHexa });
  }, [showTri, showHexa, mapReady, index]);

  return {
    load,
    ready,
    triBlocks,
    triZoom,
    lattice: latticeRef.current,
    pick: (lng, lat, block) => latticeRef.current.pick(lng, lat, block),
    centroid: (name) => latticeRef.current.centroid(name),
  };
}

/** True when a click at this zoom can name a triangle (they are drawn from here). */
export function triangleClickable(zoom: number, triZoom: number, shown: boolean): boolean {
  return shown && zoom >= Math.min(triZoom, HEXA_LINE_ZOOM) - FADE_DZ;
}
