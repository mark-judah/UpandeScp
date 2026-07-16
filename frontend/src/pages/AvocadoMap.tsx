import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { ChevronDown, Layers } from "lucide-react";
import { useScouting } from "@/hooks/use-scouting";
import { Map3D } from "@/components/Map3D";
import { LoadingOverlay } from "@/components/LoadingOverlay";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { HEADER_PILL } from "@/components/header-controls";
import { ALL, MapHeader, type MapFilterValue } from "./maps/MapHeader";
import { TreesLayer } from "./maps/TreesLayer";
import {
  fetchBlocksGeojson,
  fetchOrchardTreePoints,
  fetchTanksValvesGeojson,
  type GeoJsonFC,
  type OrchardTreePoints,
} from "@/lib/scouting-api";
import { currentWeekRange } from "@/lib/utils";


const SCOUT_PALETTE = [
  "#2BA6E0",
  "#E66BAA",
  "#8466C7",
  "#E9A23B",
  "#5BB45D",
  "#3D54B0",
  "#E63946",
  "#10b981",
  "#f97316",
  "#a855f7",
];

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

export function AvocadoMap() {
  const [filters, setFilters] = useState<MapFilterValue>(() => ({
    crop: "Avocado",
    farm: ALL,
    greenhouse: ALL,
    // Default to the current ISO week (like the rose scouting map) so the
    // first load hydrates a single week, not a fortnight of cold weeks.
    ...currentWeekRange(),
  }));
  const { data, loading, progress, weeksLoaded, weeksTotal } = useScouting({
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
  // picker but as show/hide checkboxes.
  const [showBlocks, setShowBlocks] = useState(true);
  const [showTanks, setShowTanks] = useState(true);

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
    fetchOrchardTreePoints({ farm }).then((p) => {
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

  // Build the per-tree color map from scouting entries: each scout gets a
  // colour from the palette, every tree they visited gets that colour.
  const treeColors = useMemo(() => {
    const m = new Map<string, string>();
    if (!data) return m;
    const scoutColors = new Map<string, string>();
    for (const e of data.entries) {
      if (!e.tree || !e.scouts_name) continue;
      let col = scoutColors.get(e.scouts_name);
      if (!col) {
        col = SCOUT_PALETTE[scoutColors.size % SCOUT_PALETTE.length];
        scoutColors.set(e.scouts_name, col);
      }
      m.set(e.tree, col);
    }
    return m;
  }, [data]);

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
      map.addLayer({
        id: "blocks-fill",
        type: "fill",
        source: "blocks",
        paint: { "fill-color": "#3b82f6", "fill-opacity": 0.25 },
      });
      map.addLayer({
        id: "blocks-line",
        type: "line",
        source: "blocks",
        paint: {
          "line-color": "#1d4ed8",
          "line-width": 1.5,
          "line-opacity": 0.85,
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
          "text-color": "#1e293b",
          "text-halo-color": "#ffffff",
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

  // Scout movement tracks — a faint per-scout polyline layer over the map.
  useEffect(() => {
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
  }, [tracks, mapReady]);

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
      const f = e.features?.[0];
      if (!f) return;
      const b = geometryBounds((f as any).geometry);
      if (!b) return;
      map.fitBounds(b, {
        padding: 60,
        pitch: 60,
        duration: 1000,
        bearing: 0,
      });
    });
    map.on("mouseenter", "blocks-fill", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "blocks-fill", () => {
      map.getCanvas().style.cursor = "";
    });
  };

  const treeCount = treePoints?.names.length || 0;
  const blockCount = blocks?.features.length || 0;
  const scoutedTreeCount = treeColors.size;

  return (
    <div className="flex flex-col h-svh overflow-hidden">
      <MapHeader
        title="Avocado · 3D"
        subtitle="Orchard trees · per-scout coloring · click a block to fly in"
        value={filters}
        onChange={setFilters}
        showGreenhouse={false}
        showCrop={false}
        rightSlot={
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
        }
      />

      <div className="flex items-center gap-3 px-4 md:px-6 py-2 text-xs text-muted-foreground border-b">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[#7c8b6a]" /> Unscouted
        </span>
        {Array.from(new Set(treeColors.values())).slice(0, 5).map((col) => (
          <span key={col} className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: col }}
            />
            Scout
          </span>
        ))}
        <span className="ml-auto tabular-nums">
          {blockCount} blocks · {treeCount} trees · {scoutedTreeCount} visited
        </span>
      </div>

      <div className="flex-1 min-h-0 px-4 pb-4 md:px-6 md:pb-6">
        <div className="h-full w-full overflow-hidden rounded-[20px] border border-border shadow-[var(--sd-shadow-1)]">
          <Map3D onReady={onMapReady} />
        </div>
      </div>

      <LoadingOverlay
        open={loading || loadingGeo || treesPlacing}
        progress={loading ? progress : 100}
        weeksLoaded={weeksLoaded}
        weeksTotal={weeksTotal}
      />
    </div>
  );
}
