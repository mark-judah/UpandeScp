import { useEffect, useMemo, useRef, useState } from "react";
import { FilterSelect } from "@/components/FilterSelect";
import maplibregl from "maplibre-gl";
import { ChevronDown, Layers } from "lucide-react";
import { useScouting } from "@/hooks/use-scouting";
import { Map3D } from "@/components/Map3D";
import { LoadProgress, TextSkeleton, firstLoad } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { HEADER_PILL } from "@/components/header-controls";
import { ALL, MapHeader, type MapFilterValue } from "../maps/MapHeader";
import { TreesLayer } from "../maps/TreesLayer";
import {
  fetchBlocksGeojson,
  fetchOrchardTreeRows,
  fetchTanksValvesGeojson,
  type GeoJsonFC,
  type OrchardTreePoints,
} from "@/lib/scouting-api";
import { lastMonthsRange } from "@/lib/utils";
import type { AvocadoView, MarkerPoint } from "./tree-map-types";
import { SCOUT_PALETTE } from "./derive-scouts";
import { savePin } from "@/lib/spread-api";
import type { Pt } from "@/lib/hull";
import { useDrawArea } from "../maps/use-draw-area";
import { useHouseOverlays } from "../maps/use-house-overlays";
import { DrawAreaBar } from "../maps/DrawAreaBar";
import { areaPinFeatures, draftFeatures, patchFeatures } from "./patch-features";
import { prefersReducedMotion, pulsePhase, trapPulse } from "@/lib/trap-pulse";

/** Compute a polygon's bounds quickly for fitBounds. */
function geometryBounds(
  geom: any,
): [[number, number], [number, number]] | null {
  if (!geom) return null;
  let coords: number[][] = [];
  if (geom.type === "Polygon") coords = geom.coordinates?.[0] || [];
  else if (geom.type === "MultiPolygon")
    coords = geom.coordinates?.[0]?.[0] || [];
  else if (geom.type === "Point" && geom.coordinates) {
    return [geom.coordinates as [number, number], geom.coordinates as [number, number]];
  } else return null;
  if (!coords.length) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const c of coords) {
    if (c[0] < minX) minX = c[0];
    if (c[0] > maxX) maxX = c[0];
    if (c[1] < minY) minY = c[1];
    if (c[1] > maxY) maxY = c[1];
  }
  return [
    [minX, minY],
    [maxX, maxY],
  ];
}

function farmBoundsFromBlocks(
  blocks: GeoJsonFC,
): Record<string, [[number, number], [number, number]]> {
  const farms: Record<string, { minX: number; minY: number; maxX: number; maxY: number }> = {};
  for (const f of blocks.features) {
    const farm = (f.properties?.farm || "") as string;
    if (!farm) continue;
    const b = geometryBounds(f.geometry);
    if (!b) continue;
    if (!farms[farm])
      farms[farm] = {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
      };
    farms[farm].minX = Math.min(farms[farm].minX, b[0][0]);
    farms[farm].minY = Math.min(farms[farm].minY, b[0][1]);
    farms[farm].maxX = Math.max(farms[farm].maxX, b[1][0]);
    farms[farm].maxY = Math.max(farms[farm].maxY, b[1][1]);
  }
  const out: Record<string, [[number, number], [number, number]]> = {};
  Object.entries(farms).forEach(([k, v]) => {
    out[k] = [
      [v.minX, v.minY],
      [v.maxX, v.maxY],
    ];
  });
  return out;
}

export function AvocadoTreeMap({ view }: { view: AvocadoView }) {
  const [filters, setFilters] = useState<MapFilterValue>(() => ({
    crop: "Avocado",
    farm: ALL,
    greenhouse: ALL,
    // Avocado is sparse (~0.4% of all scouting) and fetched crop-scoped, so a
    // long default window is cheap — default to the last 10 months.
    ...lastMonthsRange(10),
  }));
  const { data, loading, progress, error } = useScouting({
    from: filters.from,
    to: filters.to,
    greenhouse: filters.greenhouse === ALL ? undefined : filters.greenhouse,
    crop: filters.crop,
  });

  const [blocks, setBlocks] = useState<GeoJsonFC | null>(null);
  const [treePoints, setTreePoints] = useState<OrchardTreePoints | null>(null);
  const [tanks, setTanks] = useState<GeoJsonFC | null>(null);
  const [loadingGeo, setLoadingGeo] = useState(false);
  // True while the tree instances are still being placed (chunked build) — the
  // loader stays up until every tree is in place.
  const [treesPlacing, setTreesPlacing] = useState(false);
  // Layer visibility toggles (Boundary/blocks + Tanks), like the greenhouse
  // picker but as show/hide checkboxes. Both start hidden — the first view of
  // the map is just the trees; boundaries/tanks are opt-in via the Layers menu.
  const [showBlocks, setShowBlocks] = useState(false);
  const [showTanks, setShowTanks] = useState(false);

  // Keep map + layer refs across renders so updateColors is cheap.
  const mapRef = useRef<maplibregl.Map | null>(null);
  const treesLayerRef = useRef<TreesLayer | null>(null);
  // State (not a ref) so that when the map finishes loading, the layer-setup
  // effects below RE-RUN and add their sources/layers — otherwise any geometry
  // that arrived before the map's `load` event would never get rendered.
  const [mapReady, setMapReady] = useState(false);

  // Blocks + tanks are light — gate the map load on them. Filtered by farm;
  // endpoint caches per-farm server-side.
  useEffect(() => {
    setLoadingGeo(true);
    const farm = filters.farm === ALL ? undefined : filters.farm;
    Promise.all([fetchBlocksGeojson(), fetchTanksValvesGeojson({ farm })])
      .then(([b, tv]) => {
        setBlocks({
          ...b,
          features: (b.features || []).filter((f) => !!f.geometry),
        });
        setTanks({
          ...tv,
          features: (tv.features || []).filter((f) => !!f.geometry),
        });
      })
      .finally(() => setLoadingGeo(false));
  }, [filters.farm]);

  // Orchard trees can be huge (every tree on every avocado block), so fetch
  // them OFF the critical path — the map paints from blocks/tanks + scouting
  // immediately and the trees stream in when ready, instead of blocking the
  // whole load behind one big request.
  useEffect(() => {
    const farm = filters.farm === ALL ? undefined : filters.farm;
    let cancelled = false;
    setTreesPlacing(true);
    fetchOrchardTreeRows({ farm }).then((p) => {
      if (cancelled) return;
      // Nothing to place (e.g. "All farms" returns no trees) → clear the
      // loader immediately; otherwise the chunked build clears it on ready.
      if (!p.names.length) setTreesPlacing(false);
      setTreePoints(p);
    });
    return () => {
      cancelled = true;
    };
  }, [filters.farm]);

  // Build the per-tree color map from scouting entries, per the view.
  const treeColors = useMemo(() => view.deriveColors(data), [data, view]);

  // tree_name → [lng, lat], from the lean orchard-tree points.
  const treeCoords = useMemo(() => {
    const m = new Map<string, [number, number]>();
    const p = treePoints;
    if (p) {
      for (let i = 0; i < p.names.length; i++) {
        m.set(p.names[i], [p.coords[i * 2], p.coords[i * 2 + 1]]);
      }
    }
    return m;
  }, [treePoints]);

  // Spread (piece 3c): patches of the view's picked observation on a picked
  // block, its patch / area pins, and drawing an area pin (C5, C10).
  const obs = view.patchObservation ?? null;
  const [block, setBlock] = useState<string | null>(null);
  const spread = useHouseOverlays({
    crop: filters.crop,
    warehouse: obs ? block : null,
    observation: obs?.name ?? null,
    kind: obs?.kind ?? "pest",
    week: null,
  });
  const [pendingArea, setPendingArea] = useState<Pt[] | null>(null);
  const [areaBusy, setAreaBusy] = useState(false);
  const [areaError, setAreaError] = useState<string | null>(null);
  const draw = useDrawArea(setPendingArea);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const cancelDraw = draw.cancel;
  useEffect(() => {
    cancelDraw();
    setPendingArea(null);
  }, [block, obs?.name, obs?.kind, cancelDraw]);
  const blockNames = useMemo(
    () =>
      [
        ...new Set(
          (blocks?.features ?? [])
            .filter((f) => filters.farm === ALL || f.properties?.farm === filters.farm)
            .map((f) => String(f.properties?.block ?? ""))
            .filter(Boolean),
        ),
      ].sort(),
    [blocks, filters.farm],
  );
  const saveArea = async (title: string, shared: boolean) => {
    if (!pendingArea || !block || !obs) return;
    setAreaBusy(true);
    setAreaError(null);
    try {
      await savePin({
        crop: filters.crop,
        warehouse: block,
        kind: "Area",
        title,
        observation: obs.name,
        obs_kind: obs.kind,
        shared,
        polygon: { type: "Polygon", coordinates: [[...pendingArea, pendingArea[0]]] },
        source_week: spread.clusters?.week ?? null,
      });
      setPendingArea(null);
      spread.reloadPins();
    } catch (e) {
      setAreaError(e instanceof Error ? e.message : "Could not save the area");
    } finally {
      setAreaBusy(false);
    }
  };

  // Optional point overlay (e.g. trap catches) driven by the view.
  const markers = useMemo<MarkerPoint[]>(
    () => (view.deriveMarkers ? view.deriveMarkers(data) : []),
    [data, view],
  );

  // Scout movement tracks — per scout, tree-to-tree in time order, cut when
  // the day or block changes (so a line never jumps across the orchard). Each
  // track carries the scout's colour, drawn faint like the rose/spray trails.
  const tracks = useMemo<GeoJsonFC>(() => {
    const features: GeoJsonFC["features"] = [];
    if (!data?.entries?.length || treeCoords.size === 0) {
      return { type: "FeatureCollection", features };
    }
    const ordered = [...data.entries].sort((a, b) => {
      const ta = `${a.date_of_capture} ${a.time_of_capture || ""}`;
      const tb = `${b.date_of_capture} ${b.time_of_capture || ""}`;
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    const byScout = new Map<string, typeof ordered>();
    const scoutColor = new Map<string, string>();
    for (const e of ordered) {
      if (!e.scouts_name || !e.tree || !treeCoords.has(e.tree)) continue;
      const arr = byScout.get(e.scouts_name) || [];
      arr.push(e);
      byScout.set(e.scouts_name, arr);
      if (!scoutColor.has(e.scouts_name)) {
        scoutColor.set(
          e.scouts_name,
          SCOUT_PALETTE[scoutColor.size % SCOUT_PALETTE.length],
        );
      }
    }
    byScout.forEach((entries, scout) => {
      const color = scoutColor.get(scout) || SCOUT_PALETTE[0];
      let seg: [number, number][] = [];
      let prevKey = "";
      const flush = () => {
        if (seg.length >= 2) {
          features.push({
            type: "Feature",
            properties: { scout, color },
            geometry: { type: "LineString", coordinates: seg },
          } as GeoJsonFC["features"][number]);
        }
        seg = [];
      };
      for (const e of entries) {
        const key = `${e.date_of_capture || ""}|${e.greenhouse || e.block || ""}`;
        if (key !== prevKey) {
          flush();
          prevKey = key;
        }
        const c = treeCoords.get(e.tree as string);
        if (!c) continue;
        const last = seg[seg.length - 1];
        if (!last || last[0] !== c[0] || last[1] !== c[1]) seg.push(c);
      }
      flush();
    });
    return { type: "FeatureCollection", features };
  }, [data, treeCoords]);

  // Add MapLibre sources / layers + the Three.js TreesLayer.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (!blocks) return;

    if (!map.getSource("blocks")) {
      map.addSource("blocks", { type: "geojson", data: blocks });
      // Block boundaries in the page's warm-paper/ink palette (mirrors the
      // --sd-* design tokens; MapLibre paint takes literal colors, not CSS
      // vars). Kept subtle: a faint ink wash + a low-opacity ink hairline so
      // the boundaries read as quiet guides, not a blue overlay.
      map.addLayer({
        id: "blocks-fill",
        type: "fill",
        source: "blocks",
        paint: { "fill-color": "#0a0a0a", "fill-opacity": 0.05 }, // --sd-ink
      });
      map.addLayer({
        id: "blocks-line",
        type: "line",
        source: "blocks",
        paint: {
          "line-color": "#2a2a26", // --sd-accent (ink-2)
          "line-width": 1.25,
          "line-opacity": 0.4,
        },
      });
      map.addLayer({
        id: "blocks-labels",
        type: "symbol",
        source: "blocks",
        layout: {
          "text-field": ["get", "block_label"] as any,
          "text-size": 12,
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#2a2a26", // --sd-accent (ink-2)
          "text-halo-color": "#f4f3ef", // --sd-bg (warm paper)
          "text-halo-width": 1.5,
        },
      });
    } else {
      (map.getSource("blocks") as maplibregl.GeoJSONSource).setData(blocks);
    }

    // Tank/valve points as a small circle layer.
    if (tanks && tanks.features.length) {
      if (!map.getSource("tanks")) {
        map.addSource("tanks", { type: "geojson", data: tanks });
        map.addLayer({
          id: "tanks-circle",
          type: "circle",
          source: "tanks",
          paint: {
            "circle-color": "#8466C7",
            "circle-radius": 5,
            "circle-stroke-color": "#3D54B0",
            "circle-stroke-width": 1,
          },
        });
      } else {
        (map.getSource("tanks") as maplibregl.GeoJSONSource).setData(tanks);
      }
    }
  }, [blocks, tanks, mapReady]);

  // (Re)create the TreesLayer when trees data changes; updateColors when
  // only the colour map changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !treePoints) return;
    if (treesLayerRef.current && map.getLayer("trees")) {
      map.removeLayer("trees");
    }
    if (treePoints.names.length) {
      const layer = new TreesLayer(treePoints, treeColors, () =>
        setTreesPlacing(false),
      );
      treesLayerRef.current = layer;
      map.addLayer(layer);
    } else {
      treesLayerRef.current = null;
      setTreesPlacing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treePoints, mapReady]);

  useEffect(() => {
    treesLayerRef.current?.updateColors(treeColors);
  }, [treeColors]);

  // Optional marker overlay (e.g. trap catches), driven by the view. Size and
  // pulse grow with the count on a capped log scale (lib/trap-pulse, spec TM1);
  // the pulse is a second circle layer under the core whose radius / opacity
  // follow a per-feature phase, so only on-screen traps cost anything.
  const markersRef = useRef<MarkerPoint[]>([]);
  markersRef.current = markers;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const fc = {
      type: "FeatureCollection" as const,
      features: markers.map((m) => {
        const p = trapPulse(m.count);
        return {
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [m.lng, m.lat] },
          properties: {
            count: m.count,
            color: m.color,
            label: m.label || "",
            r: p.size / 2,
            scale: p.scale,
            dur: p.duration || 1,
            off: pulsePhase(m.label || `${m.lng},${m.lat}`),
            pulse: p.pulse ? 1 : 0,
          },
        };
      }),
    };
    if (!map.getSource("markers")) {
      map.addSource("markers", { type: "geojson", data: fc });
      map.addLayer({
        id: "markers-pulse",
        type: "circle",
        source: "markers",
        filter: ["==", ["get", "pulse"], 1],
        paint: {
          "circle-radius": ["get", "r"],
          "circle-color": ["get", "color"],
          "circle-opacity": 0,
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-width": 1.5,
          "circle-stroke-opacity": 0,
        },
      });
      map.addLayer({
        id: "markers-circle",
        type: "circle",
        source: "markers",
        paint: {
          "circle-radius": ["get", "r"],
          "circle-color": ["get", "color"],
          "circle-opacity": 0.85,
          "circle-stroke-color": "#1a1a18",
          "circle-stroke-width": 1,
        },
      });
      map.on("click", "markers-circle", (e) => {
        if (drawRef.current.active) return;
        const label = (e.features?.[0]?.properties as Record<string, unknown> | null)?.label;
        const m = markersRef.current.find((x) => x.label === label);
        if (m) focusMarkerRef.current(m);
      });
      map.on("mouseenter", "markers-circle", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "markers-circle", () => {
        map.getCanvas().style.cursor = "";
      });
    } else {
      (map.getSource("markers") as maplibregl.GeoJSONSource).setData(fc);
    }
  }, [markers, mapReady]);

  // The pulse clock: ~30 fps paint updates while any marker pulses, none under
  // reduced motion or while the tab is hidden.
  const anyPulse = useMemo(() => markers.some((m) => m.count > 0), [markers]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !anyPulse || prefersReducedMotion()) return;
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      // ~15 fps: each paint update repaints the whole map, trees included.
      if (document.hidden || now - last < 66 || !map.getLayer("markers-pulse")) return;
      last = now;
      const t = now / 1000;
      const phase = ["%", ["+", ["/", t, ["get", "dur"]], ["get", "off"]], 1];
      map.setPaintProperty("markers-pulse", "circle-radius",
        ["*", ["get", "r"], ["+", 1, ["*", ["-", ["get", "scale"], 1], phase]]] as never);
      map.setPaintProperty("markers-pulse", "circle-opacity", ["*", 0.45, ["-", 1, phase]] as never);
      map.setPaintProperty("markers-pulse", "circle-stroke-opacity", ["*", 0.8, ["-", 1, phase]] as never);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [anyPulse, mapReady]);

  // Click a marker → fly to it, then the view's card (spec TM3).
  const [selectedMarker, setSelectedMarker] = useState<MarkerPoint | null>(null);
  const focusMarkerRef = useRef<(m: MarkerPoint) => void>(() => {});
  focusMarkerRef.current = (m: MarkerPoint) => {
    const map = mapRef.current;
    if (!map || !view.markerCard) return;
    setSelectedMarker(null);
    const zoom = Math.max(map.getZoom(), 18.5);
    if (prefersReducedMotion()) {
      map.jumpTo({ center: [m.lng, m.lat], zoom });
      setSelectedMarker(m);
      return;
    }
    let done = false;
    const reveal = () => {
      if (done) return;
      done = true;
      setSelectedMarker(m);
    };
    // Listen only after flyTo starts: stopping an earlier flight fires
    // moveend synchronously, which would reveal this card too early.
    map.flyTo({ center: [m.lng, m.lat], zoom, duration: 900, essential: false });
    map.once("moveend", reveal);
    window.setTimeout(reveal, 1400);
  };
  // A marker gone from the data (range / farm change) closes its card.
  useEffect(() => {
    setSelectedMarker((cur) =>
      cur ? markers.find((m) => m.label === cur.label) ?? null : null,
    );
  }, [markers]);

  // Scout movement tracks — a faint per-scout polyline layer over the map.
  useEffect(() => {
    if (!view.showTracks) return;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const src = "scout-tracks";
    if (!map.getSource(src)) {
      map.addSource(src, { type: "geojson", data: tracks as never });
      map.addLayer({
        id: "scout-tracks-line",
        type: "line",
        source: src,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"] as never,
          "line-width": 2,
          "line-opacity": 0.4,
        },
      });
    } else {
      (map.getSource(src) as maplibregl.GeoJSONSource).setData(tracks as never);
    }
  }, [tracks, mapReady, view.showTracks]);

  // Patch outlines (red), patch / area pins (purple, dashed) and the area being
  // drawn. MapLibre paint takes literal colours: these mirror --sd-data-red /
  // --sd-data-purple. Lines only; the draft alone gets a faint fill.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const put = (id: string, data: GeoJsonFC, paint: Record<string, unknown>) => {
      const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(data as never);
        return;
      }
      map.addSource(id, { type: "geojson", data: data as never });
      map.addLayer({ id: `${id}-line`, type: "line", source: id, paint: paint as never });
    };
    put("patches", patchFeatures(spread.clusters, treeCoords), { "line-color": "#C2453A", "line-width": 2.5, "line-opacity": 0.9 });
    put("pin-areas", areaPinFeatures(spread.pins, treeCoords), { "line-color": "#8466C7", "line-width": 2, "line-dasharray": [2, 1.5] });
    put("draw-area", draftFeatures(draw.vertices), { "line-color": "#8466C7", "line-width": 2, "line-dasharray": [1, 1] });
    if (!map.getLayer("draw-area-fill")) {
      map.addLayer({
        id: "draw-area-fill",
        type: "fill",
        source: "draw-area",
        filter: ["==", ["geometry-type"], "Polygon"] as never,
        paint: { "fill-color": "#8466C7", "fill-opacity": 0.08 },
      });
    }
  }, [spread.clusters, spread.pins, treeCoords, draw.vertices, mapReady]);

  // While drawing, a double-click closes the area instead of zooming.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (draw.active) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
  }, [draw.active, mapReady]);

  // Show/hide the boundary (blocks) + tanks layers per the Layers toggle.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const setVis = (id: string, on: boolean) => {
      if (map.getLayer(id))
        map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    };
    setVis("blocks-fill", showBlocks);
    setVis("blocks-line", showBlocks);
    setVis("blocks-labels", showBlocks);
    setVis("tanks-circle", showTanks);
  }, [showBlocks, showTanks, mapReady, blocks, tanks]);

  // Fly-to. Whenever the farm filter changes, fly to the farm's bounds; the
  // user can click a block on the map to drill in further.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !blocks) return;
    if (filters.farm === ALL) {
      // Fit to all blocks present.
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const f of blocks.features) {
        const b = geometryBounds(f.geometry);
        if (!b) continue;
        if (b[0][0] < minX) minX = b[0][0];
        if (b[0][1] < minY) minY = b[0][1];
        if (b[1][0] > maxX) maxX = b[1][0];
        if (b[1][1] > maxY) maxY = b[1][1];
      }
      if (Number.isFinite(minX)) {
        map.fitBounds(
          [
            [minX, minY],
            [maxX, maxY],
          ],
          { padding: 80, pitch: 60, duration: 1000 },
        );
      }
      return;
    }
    const farmBounds = farmBoundsFromBlocks(blocks);
    const b = farmBounds[filters.farm];
    if (b)
      map.fitBounds(b, { padding: 80, pitch: 60, duration: 1000, bearing: 0 });
  }, [filters.farm, blocks, mapReady]);

  // Click a block → fly into it.
  const onMapReady = (map: maplibregl.Map) => {
    mapRef.current = map;
    map.on("load", () => {
      setMapReady(true);
    });
    map.on("click", "blocks-fill", (e) => {
      if (drawRef.current.active) return;
      // A trap marker over the block takes the click.
      if (map.getLayer("markers-circle") &&
          map.queryRenderedFeatures(e.point, { layers: ["markers-circle"] }).length) return;
      const f = e.features?.[0];
      if (!f) return;
      const name = (f.properties as Record<string, unknown> | null)?.block;
      if (name) setBlock(String(name));
      const b = geometryBounds((f as any).geometry);
      if (!b) return;
      map.fitBounds(b, {
        padding: 60,
        pitch: 60,
        duration: 1000,
        bearing: 0,
      });
    });
    map.on("click", (e) => {
      const d = drawRef.current;
      if (d.active) d.add([e.lngLat.lng, e.lngLat.lat]);
    });
    map.on("dblclick", (e) => {
      const d = drawRef.current;
      if (!d.active) return;
      e.preventDefault();
      d.finish();
    });
    map.on("mouseenter", "blocks-fill", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "blocks-fill", () => {
      map.getCanvas().style.cursor = "";
    });
  };

  // First load (no scouting processed yet): the legend, header and panel
  // headings stand, the counts and the panel's list are skeletons.
  // A failed load ends the skeletons and says so (below), rather than pulsing on.
  const first = firstLoad(loading || (!data && !error), !!data);
  const treeCount = treePoints?.names.length || 0;
  const blockCount = blocks?.features.length || 0;
  const scoutedTreeCount = treeColors.size;

  return (
    <div className="flex flex-col h-svh overflow-hidden">
      <MapHeader
        title={view.title}
        subtitle={view.subtitle}
        value={filters}
        onChange={setFilters}
        showGreenhouse={false}
        rightSlot={
          <>
            {view.headerControls}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className={HEADER_PILL}>
                  <Layers className="h-3.5 w-3.5" />
                  Layers
                  <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-44 p-2">
                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-muted">
                  <Checkbox
                    checked={showBlocks}
                    onCheckedChange={(v) => setShowBlocks(!!v)}
                  />
                  Boundary
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-muted">
                  <Checkbox
                    checked={showTanks}
                    onCheckedChange={(v) => setShowTanks(!!v)}
                  />
                  Tanks
                </label>
              </PopoverContent>
            </Popover>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-3 px-4 md:px-6 py-2 text-xs text-muted-foreground border-b">
        {/* Was a full-screen overlay; inline here so the live map shows through.
            Deliberately NOT gated on ``treesPlacing``. Placing the orchard-tree
            instances is the single most expensive thing this page does — measured
            on kaitetv16, ~28s of a 32s load, and unchanged by network throttling
            because it is CPU, not transfer. Holding a full-screen overlay over it
            hid a map that was ready to use, while the bar read "45 of 45 weeks ·
            100%" — the scouting data finishes at ~2s — so everyone diagnosed the
            fetch instead. Trees stream in over a live map now; the header says so. */}
        {error && !data && !loading && (
          <span role="alert" className="text-destructive">{error}</span>
        )}
        <LoadProgress
          active={loading || loadingGeo}
          progress={loading ? progress : 100}
          label={loading ? "Loading scouting data" : "Loading map"}
        />
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[#7c8b6a]" /> Unscouted
        </span>
        {obs ? (
          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect
              label="Block for patches"
              allLabel="Pick a block"
              value={block ?? ""}
              onChange={(v) => setBlock(v || null)}
              options={blockNames}
            />
            {block ? (
              <span className="tabular-nums">
                {obs.name}: {spread.clusters?.clusters.length ?? 0} patch
                {(spread.clusters?.clusters.length ?? 0) === 1 ? "" : "es"}
                {spread.clusters?.week ? ` · ${spread.clusters.week}` : ""}
              </span>
            ) : null}
            <DrawAreaBar
              draw={draw}
              pending={pendingArea}
              busy={areaBusy}
              disabled={!block}
              defaultTitle={`${obs.name} · area`}
              onSave={saveArea}
              onDiscard={() => setPendingArea(null)}
            />
            {areaError ? (
              <span role="alert" className="text-[var(--sd-data-red)]">
                {areaError}
              </span>
            ) : null}
          </div>
        ) : null}
        <span className="ml-auto tabular-nums">
          {first || !blocks ? (
            <TextSkeleton width="26ch" />
          ) : (
            <>
              {blockCount} blocks · {treeCount} trees · {scoutedTreeCount} visited
              {treesPlacing && treeCount > 0 ? " · drawing trees…" : ""}
            </>
          )}
        </span>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_240px] gap-4 px-4 pb-4 md:px-6 md:pb-6">
        <div className="relative h-full w-full min-h-0 overflow-hidden rounded-[20px] border border-border shadow-[var(--sd-shadow-1)]">
          <Map3D onReady={onMapReady} />
          {selectedMarker && view.markerCard ? (
            <div className="absolute bottom-4 left-4 z-10">
              {view.markerCard(selectedMarker, { from: filters.from, to: filters.to }, () =>
                setSelectedMarker(null),
              )}
            </div>
          ) : null}
        </div>

        {/* Docked side panel — content supplied by the view. */}
        <aside
          className="hidden lg:flex flex-col min-h-0 overflow-hidden rounded-[20px] border border-border bg-card shadow-[var(--sd-shadow-1)]"
          aria-busy={first || undefined}
        >
          {view.renderPanel(data, first)}
          <div className="border-t px-3 py-2 text-[0.7rem] tabular-nums text-muted-foreground">
            {first || !treePoints ? (
              <TextSkeleton width="16ch" />
            ) : (
              <>
                {scoutedTreeCount} of {treeCount} trees visited
              </>
            )}
          </div>
        </aside>
      </div>

    </div>
  );
}
