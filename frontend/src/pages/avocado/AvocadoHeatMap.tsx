/**
 * Avocado Heat maps — a top-down (2D) view of the orchard where a smooth
 * MapLibre heatmap field shows where pest/disease pressure is concentrated
 * (green → yellow → red), with faint tree dots underneath for orientation.
 *
 * Reuses the shared avocado map plumbing (Map3D, MapHeader filters + single-farm
 * auto-select, cached useScouting, lean tree points) but renders a heatmap +
 * dots instead of the 3D TreesLayer. A thin, collapsible planning sidebar lists
 * the most-affected blocks; picking one shows its top pests/diseases and a
 * (stubbed) "Plan spray" action — observe now, prescribe next.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { ChevronDown, ClipboardList, Layers, X } from "lucide-react";
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
import { ALL, MapHeader, type MapFilterValue } from "../maps/MapHeader";
import {
  fetchBlocksGeojson,
  fetchOrchardTreeRows,
  type GeoJsonFC,
  type OrchardTreePoints,
} from "@/lib/scouting-api";
import { lastMonthsRange } from "@/lib/utils";
import { useObservationColors } from "@/lib/observation-colors";

function toNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}
/** (0,0) is the Atlantic — treat as missing. */
function validCoord(lat: number | null, lng: number | null): boolean {
  return (
    lat != null && lng != null && !(Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001)
  );
}
function allBlocksBounds(
  blocks: GeoJsonFC,
): [[number, number], [number, number]] | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const f of blocks.features) {
    const g: any = f.geometry;
    const ring =
      g?.type === "Polygon"
        ? g.coordinates?.[0]
        : g?.type === "MultiPolygon"
          ? g.coordinates?.[0]?.[0]
          : null;
    if (!ring) continue;
    for (const c of ring) {
      minX = Math.min(minX, c[0]);
      maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]);
      maxY = Math.max(maxY, c[1]);
    }
  }
  return Number.isFinite(minX)
    ? [
        [minX, minY],
        [maxX, maxY],
      ]
    : null;
}
/** Colour a block's dot in the sidebar by observation magnitude. */
function magnitudeDot(obs: number): string {
  return obs >= 20 ? "#dc2626" : obs >= 8 ? "#e9a23b" : "#5bb45d";
}

interface BlockAgg {
  block: string;
  obs: number; // total pest + disease observations
  trees: Set<string>;
  pests: Map<string, number>;
  diseases: Map<string, number>;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function AvocadoHeatMap() {
  const [filters, setFilters] = useState<MapFilterValue>(() => ({
    crop: "Avocado",
    farm: ALL,
    greenhouse: ALL,
    // Sparse crop, crop-scoped fetch → default to a long 10-month window.
    ...lastMonthsRange(10),
  }));
  const { data, loading, progress, weeksLoaded, weeksTotal } = useScouting({
    from: filters.from,
    to: filters.to,
    greenhouse: filters.greenhouse === ALL ? undefined : filters.greenhouse,
    crop: filters.crop,
  });

  const [blocks, setBlocks] = useState<GeoJsonFC | null>(null);
  const [treePoints, setTreePoints] = useState<OrchardTreePoints | null>(null);
  const [loadingGeo, setLoadingGeo] = useState(false);
  const [showBoundary, setShowBoundary] = useState(false);
  const [showTrees, setShowTrees] = useState(true);
  const [planOpen, setPlanOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const { pest: pestColor, disease: diseaseColor } = useObservationColors();

  // Blocks (all) for boundary + fit; trees (per farm) for the faint dot layer.
  useEffect(() => {
    setLoadingGeo(true);
    fetchBlocksGeojson()
      .then((b) =>
        setBlocks({
          ...b,
          features: (b.features || []).filter((f) => !!f.geometry),
        }),
      )
      .finally(() => setLoadingGeo(false));
  }, []);
  useEffect(() => {
    const farm = filters.farm === ALL ? undefined : filters.farm;
    let cancelled = false;
    fetchOrchardTreeRows({ farm }).then((p) => {
      if (!cancelled) setTreePoints(p);
    });
    return () => {
      cancelled = true;
    };
  }, [filters.farm]);

  // Heat field points: one per scouting entry with coords, weighted by the
  // total pest + disease observations recorded there.
  const heatFC = useMemo(() => {
    const features: any[] = [];
    if (data) {
      for (const e of data.entries) {
        const lat = toNum(e.latitude);
        const lng = toNum(e.longitude);
        if (!validCoord(lat, lng)) continue;
        let w = 0;
        for (const p of e.pests_scouting_entry || []) w += p.count || 1;
        w += (e.diseases_scouting_entry || []).length;
        if (w <= 0) continue;
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [lng, lat] },
          properties: { w },
        });
      }
    }
    return { type: "FeatureCollection", features } as const;
  }, [data]);

  // Faint tree dots for orientation under the heat field.
  const treeFC = useMemo(() => {
    const features: any[] = [];
    const p = treePoints;
    if (p) {
      for (let i = 0; i < p.names.length; i++)
        features.push({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [p.coords[i * 2], p.coords[i * 2 + 1]],
          },
          properties: {},
        });
    }
    return { type: "FeatureCollection", features } as const;
  }, [treePoints]);

  // Per-block aggregation (from entries) — drives the planning sidebar.
  const blockAggs = useMemo(() => {
    const m = new Map<string, BlockAgg>();
    if (data) {
      for (const e of data.entries) {
        const block = e.block || "";
        if (!block) continue;
        let a = m.get(block);
        if (!a) {
          a = {
            block,
            obs: 0,
            trees: new Set(),
            pests: new Map(),
            diseases: new Map(),
            minX: Infinity,
            minY: Infinity,
            maxX: -Infinity,
            maxY: -Infinity,
          };
          m.set(block, a);
        }
        if (e.tree) a.trees.add(e.tree);
        for (const p of e.pests_scouting_entry || []) {
          if (!p.pest) continue;
          const c = p.count || 1;
          a.pests.set(p.pest, (a.pests.get(p.pest) || 0) + c);
          a.obs += c;
        }
        for (const d of e.diseases_scouting_entry || []) {
          if (!d.disease) continue;
          a.diseases.set(d.disease, (a.diseases.get(d.disease) || 0) + 1);
          a.obs += 1;
        }
        const lat = toNum(e.latitude);
        const lng = toNum(e.longitude);
        if (validCoord(lat, lng)) {
          a.minX = Math.min(a.minX, lng as number);
          a.maxX = Math.max(a.maxX, lng as number);
          a.minY = Math.min(a.minY, lat as number);
          a.maxY = Math.max(a.maxY, lat as number);
        }
      }
    }
    return Array.from(m.values()).sort((x, y) => y.obs - x.obs);
  }, [data]);

  const affected = blockAggs.filter((b) => b.obs > 0);
  const totalObs = blockAggs.reduce((s, b) => s + b.obs, 0);
  const selectedAgg = useMemo(
    () => blockAggs.find((b) => b.block === selected) || null,
    [blockAggs, selected],
  );

  const onMapReady = (map: maplibregl.Map) => {
    mapRef.current = map;
    map.on("load", () => setMapReady(true));
  };

  // Heat field.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (!map.getSource("heat")) {
      map.addSource("heat", { type: "geojson", data: heatFC as never });
      map.addLayer({
        id: "heat",
        type: "heatmap",
        source: "heat",
        paint: {
          "heatmap-weight": ["interpolate", ["linear"], ["get", "w"], 0, 0, 8, 1],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 12, 0.6, 18, 1.4],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 12, 10, 16, 22, 20, 40],
          "heatmap-opacity": 0.75,
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0, "rgba(0,0,0,0)",
            0.15, "rgba(91,180,93,0.55)",
            0.4, "rgba(233,162,59,0.7)",
            0.7, "rgba(230,110,40,0.85)",
            1, "rgba(220,38,38,0.92)",
          ],
        },
      });
    } else {
      (map.getSource("heat") as maplibregl.GeoJSONSource).setData(heatFC as never);
    }
  }, [heatFC, mapReady]);

  // Faint tree dots (kept below the heat layer).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (!map.getSource("tree-dots")) {
      map.addSource("tree-dots", { type: "geojson", data: treeFC as never });
      map.addLayer(
        {
          id: "tree-dots",
          type: "circle",
          source: "tree-dots",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 0.8, 17, 2, 20, 3.5],
            "circle-color": "rgba(58,58,52,0.35)",
          },
        },
        map.getLayer("heat") ? "heat" : undefined,
      );
    } else {
      (map.getSource("tree-dots") as maplibregl.GeoJSONSource).setData(
        treeFC as never,
      );
    }
  }, [treeFC, mapReady]);

  // Block boundary (off by default) + the selected-block highlight.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !blocks) return;
    if (!map.getSource("blocks")) {
      map.addSource("blocks", { type: "geojson", data: blocks as never });
      map.addLayer({
        id: "blocks-line",
        type: "line",
        source: "blocks",
        paint: { "line-color": "#2a2a26", "line-width": 1.25, "line-opacity": 0.4 },
      });
    } else {
      (map.getSource("blocks") as maplibregl.GeoJSONSource).setData(
        blocks as never,
      );
    }
    if (!map.getSource("block-sel")) {
      map.addSource("block-sel", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] } as never,
      });
      map.addLayer({
        id: "block-sel",
        type: "line",
        source: "block-sel",
        paint: { "line-color": "#d9a514", "line-width": 2.5, "line-opacity": 0.95 },
      });
    }
  }, [blocks, mapReady]);

  // Layer visibility toggles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const setVis = (id: string, on: boolean) => {
      if (map.getLayer(id))
        map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    };
    setVis("blocks-line", showBoundary);
    setVis("tree-dots", showTrees);
  }, [showBoundary, showTrees, mapReady]);

  // Fit to the orchard on load / farm change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !blocks) return;
    const b = allBlocksBounds(blocks);
    if (b) map.fitBounds(b, { padding: 60, duration: 800 });
  }, [blocks, mapReady, filters.farm]);

  // Select an affected block → open the panel, fly to its observations, and
  // highlight its polygon if we can match it in the blocks layer.
  const selectBlock = (block: string) => {
    setSelected(block);
    setPlanOpen(true);
    const map = mapRef.current;
    const agg = blockAggs.find((b) => b.block === block);
    if (map && agg && Number.isFinite(agg.minX)) {
      map.fitBounds(
        [
          [agg.minX, agg.minY],
          [agg.maxX, agg.maxY],
        ],
        { padding: 140, duration: 800, maxZoom: 18 },
      );
    }
    const feat = blocks?.features.find((f) => {
      const p: any = f.properties || {};
      return p.block === block || p.block_label === block || p.name === block;
    });
    const sel = map?.getSource("block-sel") as maplibregl.GeoJSONSource | undefined;
    if (sel)
      sel.setData({
        type: "FeatureCollection",
        features: feat ? [feat as never] : [],
      } as never);
  };

  const topN = (m: Map<string, number>, n = 5) =>
    Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);

  return (
    <div className="flex flex-col h-svh overflow-hidden">
      <MapHeader
        title="Heat maps"
        subtitle="Orchard pest & disease intensity · red = most affected"
        value={filters}
        onChange={setFilters}
        showGreenhouse={false}
        showCrop={false}
        rightSlot={
          <>
            <Button
              variant={planOpen ? "default" : "outline"}
              size="sm"
              className={HEADER_PILL}
              onClick={() => setPlanOpen((o) => !o)}
            >
              <ClipboardList className="h-3.5 w-3.5" />
              Plan
            </Button>
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
                    checked={showTrees}
                    onCheckedChange={(v) => setShowTrees(!!v)}
                  />
                  Trees
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-muted">
                  <Checkbox
                    checked={showBoundary}
                    onCheckedChange={(v) => setShowBoundary(!!v)}
                  />
                  Boundary
                </label>
              </PopoverContent>
            </Popover>
          </>
        }
      />

      <div className="flex items-center gap-3 px-4 md:px-6 py-2 text-xs text-muted-foreground border-b">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: "#5bb45d" }} /> Low
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: "#e9a23b" }} /> Medium
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: "#dc2626" }} /> High
        </span>
        <span className="ml-auto tabular-nums">
          {affected.length} affected blocks · {totalObs} observations
        </span>
      </div>

      <div
        className={`flex-1 min-h-0 grid grid-cols-1 gap-4 px-4 pb-4 md:px-6 md:pb-6 ${
          planOpen ? "lg:grid-cols-[1fr_300px]" : ""
        }`}
      >
        <div className="h-full w-full min-h-0 overflow-hidden rounded-[20px] border border-border shadow-[var(--sd-shadow-1)]">
          <Map3D onReady={onMapReady} initialPitch={0} />
        </div>

        {planOpen && (
          <aside className="hidden lg:flex flex-col min-h-0 overflow-hidden rounded-[20px] border border-border bg-card shadow-[var(--sd-shadow-1)]">
            <div className="flex items-center justify-between border-b px-3 py-2.5">
              <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                {selectedAgg ? "Block" : "Affected blocks"}
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() =>
                  selectedAgg ? setSelected(null) : setPlanOpen(false)
                }
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-2">
              {!selectedAgg ? (
                affected.length ? (
                  affected.map((b) => (
                    <button
                      key={b.block}
                      type="button"
                      onClick={() => selectBlock(b.block)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-muted"
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: magnitudeDot(b.obs) }}
                        aria-hidden
                      />
                      <span className="flex-1 truncate" title={b.block}>
                        {b.block}
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {b.obs}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    No affected blocks this week
                  </div>
                )
              ) : (
                <div className="space-y-3 p-1 text-xs">
                  <div>
                    <div className="text-sm font-semibold">
                      {selectedAgg.block}
                    </div>
                    <div className="text-muted-foreground">
                      {selectedAgg.obs} observations · {selectedAgg.trees.size}{" "}
                      trees scouted
                    </div>
                  </div>

                  {[
                    { title: "Top pests", rows: topN(selectedAgg.pests), colorOf: pestColor },
                    { title: "Top diseases", rows: topN(selectedAgg.diseases), colorOf: diseaseColor },
                  ].map((s) => (
                    <div key={s.title}>
                      <div className="mb-1 text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                        {s.title}
                      </div>
                      {s.rows.length ? (
                        s.rows.map(([name, count]) => (
                          <div
                            key={name}
                            className="flex items-center gap-2 rounded px-1.5 py-1"
                          >
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full border"
                              style={{ background: s.colorOf(name) }}
                              aria-hidden
                            />
                            <span className="flex-1 truncate" title={name}>
                              {name}
                            </span>
                            <span className="tabular-nums text-muted-foreground">
                              {count}
                            </span>
                          </div>
                        ))
                      ) : (
                        <div className="px-1.5 py-1 text-muted-foreground">None</div>
                      )}
                    </div>
                  ))}

                  <div className="pt-1">
                    <Button size="sm" className="w-full" disabled>
                      Plan spray
                    </Button>
                    <p className="mt-1 text-center text-[0.7rem] text-muted-foreground">
                      Prescription flow comes next
                    </p>
                  </div>
                </div>
              )}
            </div>
          </aside>
        )}
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
