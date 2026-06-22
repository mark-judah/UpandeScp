import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { useScouting } from "@/hooks/use-scouting";
import { Map3D } from "@/components/Map3D";
import { LoadingOverlay } from "@/components/LoadingOverlay";
import { ALL, MapHeader, type MapFilterValue } from "./maps/MapHeader";
import { TreesLayer } from "./maps/TreesLayer";
import {
  fetchBlocksGeojson,
  fetchOrchardTreesGeojson,
  fetchTanksValvesGeojson,
  type GeoJsonFC,
} from "@/lib/scouting-api";
import { ymd } from "@/lib/utils";

function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 14);
  return { from: ymd(from), to: ymd(today) };
}

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
    ...defaultRange(),
  }));
  const { data, loading, progress, weeksLoaded, weeksTotal } = useScouting({
    from: filters.from,
    to: filters.to,
    crop: filters.crop,
  });

  const [blocks, setBlocks] = useState<GeoJsonFC | null>(null);
  const [trees, setTrees] = useState<GeoJsonFC | null>(null);
  const [tanks, setTanks] = useState<GeoJsonFC | null>(null);
  const [loadingGeo, setLoadingGeo] = useState(false);

  // Keep map + layer refs across renders so updateColors is cheap.
  const mapRef = useRef<maplibregl.Map | null>(null);
  const treesLayerRef = useRef<TreesLayer | null>(null);
  const mapReadyRef = useRef(false);

  // Fetch the geometry once. Filtered by farm — endpoint already caches
  // per-farm server-side.
  useEffect(() => {
    setLoadingGeo(true);
    const farm = filters.farm === ALL ? undefined : filters.farm;
    Promise.all([
      fetchBlocksGeojson(),
      fetchOrchardTreesGeojson({ farm }),
      fetchTanksValvesGeojson({ farm }),
    ])
      .then(([b, t, tv]) => {
        // Render only blocks/trees that actually have geometry — no empty
        // placeholders. The user explicitly asked for this.
        setBlocks({
          ...b,
          features: (b.features || []).filter((f) => !!f.geometry),
        });
        setTrees({
          ...t,
          features: (t.features || []).filter(
            (f) => !!f.geometry && f.geometry.type === "Point",
          ),
        });
        setTanks({
          ...tv,
          features: (tv.features || []).filter((f) => !!f.geometry),
        });
      })
      .finally(() => setLoadingGeo(false));
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

  // Add MapLibre sources / layers + the Three.js TreesLayer.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
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
  }, [blocks, tanks]);

  // (Re)create the TreesLayer when trees data changes; updateColors when
  // only the colour map changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current || !trees) return;
    if (treesLayerRef.current && map.getLayer("trees")) {
      map.removeLayer("trees");
    }
    if (trees.features.length) {
      const layer = new TreesLayer(trees.features as any, treeColors);
      treesLayerRef.current = layer;
      map.addLayer(layer);
    } else {
      treesLayerRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trees]);

  useEffect(() => {
    treesLayerRef.current?.updateColors(treeColors);
  }, [treeColors]);

  // Fly-to. Whenever the farm filter changes, fly to the farm's bounds; the
  // user can click a block on the map to drill in further.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current || !blocks) return;
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
  }, [filters.farm, blocks]);

  // Click a block → fly into it.
  const onMapReady = (map: maplibregl.Map) => {
    mapRef.current = map;
    map.on("load", () => {
      mapReadyRef.current = true;
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

  const treeCount = trees?.features.length || 0;
  const blockCount = blocks?.features.length || 0;
  const scoutedTreeCount = treeColors.size;

  return (
    <div className="flex flex-col min-h-svh">
      <MapHeader
        title="Avocado · 3D"
        subtitle="Orchard trees · per-scout coloring · click a block to fly in"
        value={filters}
        onChange={setFilters}
        showGreenhouse={false}
        showCrop={false}
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

      <div className="flex-1 min-h-0">
        <Map3D onReady={onMapReady} />
      </div>

      <LoadingOverlay
        open={loading || loadingGeo}
        progress={loading ? progress : 100}
        weeksLoaded={weeksLoaded}
        weeksTotal={weeksTotal}
      />
    </div>
  );
}
