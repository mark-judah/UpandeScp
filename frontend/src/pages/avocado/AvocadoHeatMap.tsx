/**
 * Avocado/coffee Jobsheet — a top-down (2D) view of the orchard showing ONE pest or
 * disease at a time (searchable pill). Every located scouting entry is a sample,
 * zero where scouted and not found; fixed-trap catches count for pests; the gaps
 * are filled by inverse-distance weighting (lib/idw.ts) across the block polygons
 * and drawn as a canvas image, faded with distance to the nearest scout.
 *
 * Reuses the shared avocado map plumbing (Map3D, MapHeader filters + single-farm
 * auto-select, cached useScouting, lean tree points) but renders a heatmap +
 * dots instead of the 3D TreesLayer. A thin, collapsible planning sidebar lists
 * the most-affected blocks; picking one shows its top pests/diseases and then the
 * prescription itself — observe and prescribe in one place, which is why this page is
 * the avocado **Jobsheet** rather than a heat map with a sidebar. The plan it creates
 * is an ordinary Application Floor Plan: same draft endpoint, same approval, same
 * transfer, with the block riding in `custom_greenhouse`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { ChevronDown, ClipboardList, Layers } from "lucide-react";
import { useScouting } from "@/hooks/use-scouting";
import { MapFloatingCard } from "@/components/maps/MapFloatingCard";
import { MapPanelDock } from "@/components/maps/MapPanelDock";
import { MapKpiPill } from "@/components/maps/MapKpiPill";
import { Map3D } from "@/components/Map3D";
import { LoadProgress, RowsSkeleton, TextSkeleton, firstLoad } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { HEADER_PILL } from "@/components/header-controls";
import { BlockSprayPlan } from "./BlockSprayPlan";
import { BlockGroupsPanel, groupKey } from "./BlockGroupsPanel";
import { featureTag, groupAdjacentBlocks } from "@/lib/block-groups";
import { fetchCreatorBootstrap } from "@/lib/spray-plan-creator-api";
import { BAND_COLOR, BAND_LABEL, bandRank, judgedLabel, perHectare, type Band, type HouseFigure } from "@/lib/pest-bands";
import { useHouseFigures } from "@/hooks/use-house-figures";
import { ALL, MapHeader, type MapFilterValue } from "../maps/MapHeader";
import {
  fetchBlockAreas,
  fetchBlocksGeojson,
  fetchOrchardTreeRows,
  type GeoJsonFC,
  type OrchardTreePoints,
} from "@/lib/scouting-api";
import { lastMonthsRange } from "@/lib/utils";
import { useObservationColors } from "@/lib/observation-colors";
import { fetchTrapLocations, type TrapLocations } from "@/lib/scouting-api";
import { classOf } from "@/lib/idw";
import { computeField, FIELD_RADIUS_M, observationOptions, type ObsOption } from "@/lib/pest-heat";
import { ObservationPicker, obsKey } from "./ObservationPicker";

/** Band colours of the field: none/low, medium, high. */
const FIELD_COLORS: [string, string, string] = ["#5bb45d", "#e9a23b", "#dc2626"];
/** A block's name as scouting entries carry it (same match `selectBlock` uses). */
const blockTag = (p: any): string => p?.block || p?.block_label || p?.name || "";
/** Blocks whose edges are this close (m) are sprayed as one run. */
const JOIN_TOLERANCE_M = 15;

const fmt = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "-");
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

export function AvocadoHeatMap({ initialCrop = "Avocado" }: { initialCrop?: string } = {}) {
  const [filters, setFilters] = useState<MapFilterValue>(() => ({
    crop: initialCrop,
    farm: ALL,
    greenhouse: ALL,
    // Sparse crop, crop-scoped fetch → default to a long 10-month window.
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
  const [loadingGeo, setLoadingGeo] = useState(false);
  const [showBoundary, setShowBoundary] = useState(false);
  const [showTrees, setShowTrees] = useState(true);
  const [planOpen, setPlanOpen] = useState(false);
  // Block areas, for count per hectare.
  const [blockAreas, setBlockAreas] = useState<Record<string, number>>({});
  // Which pests this plan is aimed at. The rose planner asks the same question
  // — what are we spraying for — and the answer rides onto the plan's scope.
  const [targets, setTargets] = useState<string[]>([]);
  // Blocks ticked for a spray run (map click or sidebar), in pick order; `selected`
  // is the one most recently picked — its pests/diseases fill the detail below.
  const [picked, setPicked] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // Which run (groupKey) has its plan form open.
  const [planKey, setPlanKey] = useState<string | null>(null);
  const [bootCc, setBootCc] = useState<Record<string, string | null>>({});
  const [bootAreas, setBootAreas] = useState<Record<string, number>>({});
  // The one pest or disease the field shows (null = the most-seen pest).
  const [pickedObs, setPickedObs] = useState<string | null>(null);
  const [fixedTraps, setFixedTraps] = useState<TrapLocations>({});
  // Targets belong to the block they were chosen on. Carrying them across would
  // quietly plan a spray for pests nobody looked at on the new block.

  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const { pest: pestColor, disease: diseaseColor } = useObservationColors();

  // Blocks (all) for boundary + fit; trees (per farm) for the faint dot layer.
  useEffect(() => {
    let cancelled = false;
    const farm = filters.farm === ALL ? undefined : filters.farm;
    void fetchBlockAreas({ farm })
      .catch(() => ({}))
      .then((areas) => {
        if (!cancelled) setBlockAreas(areas || {});
      });
    return () => {
      cancelled = true;
    };
  }, [filters.farm]);

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

  // Cost centre and area per block, as the planner will see them.
  useEffect(() => {
    let cancelled = false;
    fetchCreatorBootstrap(filters.crop)
      .then((b) => {
        if (cancelled) return;
        setBootCc(Object.fromEntries((b.blocks || []).map((x) => [x.name, x.cost_center || null])));
        setBootAreas(Object.fromEntries((b.blocks || []).map((x) => [x.name, x.area_ha || 0])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [filters.crop]);

  useEffect(() => {
    let cancelled = false;
    void fetchTrapLocations(filters.farm === ALL ? undefined : filters.farm).then((t) => {
      if (!cancelled) setFixedTraps(t);
    });
    return () => {
      cancelled = true;
    };
  }, [filters.farm]);

  // The observations seen in the window; the field shows one of them.
  const obsOptions = useMemo(() => (data ? observationOptions(data.entries) : []), [data]);
  const obs: ObsOption | null =
    obsOptions.find((o) => obsKey(o) === pickedObs) ??
    obsOptions.find((o) => o.kind === "pest" && o.count > 0) ??
    obsOptions[0] ??
    null;
  const obsId = obs ? obsKey(obs) : null;

  // The field for the picked observation: every located entry is a sample
  // (0 where scouted and not found), IDW-filled across the block polygons.
  const fieldResult = useMemo(
    () => (data && obs && blocks ? computeField(data.entries, obs, blocks, fixedTraps, blockTag, FIELD_COLORS) : null),
    [data, obs, blocks, fixedTraps],
  );
  const heat = fieldResult?.kind === "ok" ? fieldResult : null;
  // Why the map is blank, said plainly (coffee blocks may not be keyed in yet).
  const emptyMsg =
    !data || loading || loadingGeo || !blocks
      ? null
      : blocks.features.length === 0 || fieldResult?.kind === "no-blocks"
        ? "No blocks mapped for this crop yet"
        : !obs || fieldResult?.kind === "no-samples"
          ? "No geo-tagged scouting for this crop in this window"
          : null;

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

  // Blocks ranked by the picked observation: mean of the filled field, and the
  // share of the filled area in the red band (not by total observations).
  const ranked = useMemo(
    () =>
      (heat?.blocks ?? [])
        .filter((b) => b.tag && b.coverage > 0)
        .sort((x, y) => y.mean - x.mean || y.redShare - x.redShare),
    [heat],
  );
  useEffect(() => {
    if (!picked.length) setTargets([]);
  }, [picked.length]);

  const areas = useMemo(() => ({ ...bootAreas, ...blockAreas }), [bootAreas, blockAreas]);
  // Touching picks join into one run; the rest stay separate runs.
  const groups = useMemo(
    () => (blocks ? groupAdjacentBlocks(blocks.features, picked, JOIN_TOLERANCE_M) : picked.map((b) => [b])),
    [blocks, picked],
  );
  const planGroup = planKey ? groups.find((g) => groupKey(g) === planKey) || null : null;
  useEffect(() => {
    if (planKey && !planGroup) setPlanKey(null);
  }, [planKey, planGroup]);

  const selectedAgg = useMemo(
    () => blockAggs.find((b) => b.block === selected) || null,
    [blockAggs, selected],
  );

  // Each pest of the selected block, judged on the server exactly as the
  // alerts and the weekly sheet judge it (thresholds D8).
  const houseFigs = useHouseFigures(filters.crop, selectedAgg?.block ?? null, filters.from, filters.to);

  const onMapReady = (map: maplibregl.Map) => {
    mapRef.current = map;
    map.on("load", () => setMapReady(true));
  };

  // Heat field: the IDW grid as a canvas image over the grid's bounding box
  // (below the tree dots and the block outlines).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (!heat) {
      if (map.getLayer("heat")) map.setLayoutProperty("heat", "visibility", "none");
      return;
    }
    const { grid } = heat;
    const canvas = document.createElement("canvas");
    canvas.width = grid.cols;
    canvas.height = grid.rows;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(new ImageData(heat.rgba as unknown as Uint8ClampedArray<ArrayBuffer>, grid.cols, grid.rows), 0, 0);
    const url = canvas.toDataURL("image/png");
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
      [grid.west, grid.north],
      [grid.east, grid.north],
      [grid.east, grid.south],
      [grid.west, grid.south],
    ];
    const src = map.getSource("heat") as maplibregl.ImageSource | undefined;
    if (!src) {
      map.addSource("heat", { type: "image", url, coordinates });
      map.addLayer(
        {
          id: "heat",
          type: "raster",
          source: "heat",
          paint: { "raster-opacity": 1, "raster-fade-duration": 0, "raster-resampling": "linear" },
        },
        map.getLayer("tree-dots") ? "tree-dots" : undefined,
      );
    } else {
      src.updateImage({ url, coordinates });
      map.setLayoutProperty("heat", "visibility", "visible");
    }
  }, [heat, mapReady]);

  // Faint tree dots (above the heat field).
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
      // Invisible fill: gives the polygons a click/hover target.
      map.addLayer({
        id: "blocks-fill",
        type: "fill",
        source: "blocks",
        paint: { "fill-color": "#000000", "fill-opacity": 0 },
      });
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
        id: "block-sel-fill",
        type: "fill",
        source: "block-sel",
        paint: { "fill-color": "#d9a514", "fill-opacity": 0.22 },
      });
      map.addLayer({
        id: "block-sel-halo",
        type: "line",
        source: "block-sel",
        paint: { "line-color": "#ffffff", "line-width": 6, "line-opacity": 0.9 },
      });
      map.addLayer({
        id: "block-sel",
        type: "line",
        source: "block-sel",
        paint: { "line-color": "#d9a514", "line-width": 3, "line-opacity": 1 },
      });
      // Joined runs: the members' outer edges again, thicker, as one outline.
      map.addSource("block-group", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] } as never,
      });
      map.addLayer({
        id: "block-group",
        type: "line",
        source: "block-group",
        paint: { "line-color": "#8a6508", "line-width": 4.5, "line-opacity": 0.9 },
      });
      map.on("click", "blocks-fill", (e) => {
        const tag = blockTag(e.features?.[0]?.properties);
        if (tag) toggleRef.current(tag, false);
      });
      map.on("mouseenter", "blocks-fill", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "blocks-fill", () => (map.getCanvas().style.cursor = ""));
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

  // Tick / untick a block for the run. From the list the map flies to its
  // observations (when it is the first pick); from a map click it stays put.
  const toggleBlock = (block: string, fly = true) => {
    const on = !picked.includes(block);
    const next = on ? [...picked, block] : picked.filter((b) => b !== block);
    setPicked(next);
    setSelected(on ? block : next[next.length - 1] ?? null);
    if (on) setPlanOpen(true);
    const map = mapRef.current;
    const agg = blockAggs.find((b) => b.block === block);
    if (fly && on && picked.length === 0 && map && agg && Number.isFinite(agg.minX)) {
      map.fitBounds(
        [
          [agg.minX, agg.minY],
          [agg.maxX, agg.maxY],
        ],
        { padding: 140, duration: 800, maxZoom: 18 },
      );
    }
  };
  // The list is clipped once there are picks, so a block picked on the map
  // (or one of the tail ranks) can sit out of view: scroll its checked row in.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!selected || !picked.includes(selected)) return;
    const box = listRef.current;
    const row = box
      ? Array.from(box.querySelectorAll<HTMLElement>("[data-block]")).find((r) => r.dataset.block === selected)
      : null;
    if (!box || !row) return;
    const top = row.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top + row.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = Math.max(0, top - box.clientHeight / 2 + row.offsetHeight / 2);
  }, [selected, picked, planOpen]);
  const toggleRef = useRef(toggleBlock);
  toggleRef.current = toggleBlock;

  // Outline + light fill for the picks; a thick outline for each joined run.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !blocks) return;
    const byTag = new Map(blocks.features.map((f) => [featureTag(f), f]));
    const feats = (names: string[]) => names.map((n) => byTag.get(n)).filter((f) => !!f);
    (map.getSource("block-sel") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: feats(picked),
    } as never);
    (map.getSource("block-group") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: groups.filter((g) => g.length > 1).flatMap(feats),
    } as never);
  }, [picked, groups, blocks, mapReady]);

  const topN = (m: Map<string, number>, n = 5) =>
    Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);

  // Pests for the selected block, ranked by the band the server judged — the
  // pest furthest over its threshold leads, not merely the biggest count. A pest
  // with no band keeps its place by count rather than being dropped.
  const rankedPests = useMemo(() => {
    if (!selectedAgg) return [] as Array<readonly [string, number, Band, HouseFigure | null]>;
    return Array.from(selectedAgg.pests.entries())
      .map(([name, count]) => {
        const f = houseFigs[name] ?? null;
        return [name, count, f?.band ?? null, f] as const;
      })
      .sort((a, b) => bandRank(b[2]) - bandRank(a[2]) || b[1] - a[1])
      .slice(0, 8);
  }, [selectedAgg, houseFigs]);

  // First load (no scouting processed yet): the legend and panel headings
  // stand, the counts and the affected-block list are skeletons.
  // A failed load ends the skeletons and says so (below), rather than pulsing on.
  const first = firstLoad(loading || (!data && !error), !!data);

  return (
    <div className="flex flex-col h-svh overflow-hidden">
      <MapHeader
        // The sidebar has called this "Jobsheet" since the prescribe flow
        // landed on it; the heading still said "Heat maps", so the page a
        // manager was sent to did not match the name they were sent to.
        title="Jobsheet"
        subtitle={obs ? `${obs.name} · zeros count · estimated between scouts` : "Orchard pest & disease"}
        value={filters}
        onChange={setFilters}
        showGreenhouse={false}
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
        {/* Was a full-screen overlay; inline here so the map shows through. */}
        {error && !data && !loading && (
          <span role="alert" className="text-destructive">{error}</span>
        )}
        <LoadProgress active={loading || loadingGeo} progress={loading ? progress : 100} />
        <ObservationPicker options={obsOptions} value={obs} onChange={(o) => setPickedObs(obsKey(o))} />
        {[
          ["None / low", FIELD_COLORS[0]],
          ["Medium", FIELD_COLORS[1]],
          ["High", FIELD_COLORS[2]],
        ].map(([label, c]) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: c }} /> {label}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-full opacity-40" style={{ background: "linear-gradient(90deg, #e9a23b, transparent)" }} />
          Estimated (no scout within {FIELD_RADIUS_M} m)
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-2 w-4 rounded-sm"
            style={{ background: "repeating-linear-gradient(135deg, rgba(90,90,84,0.5) 0 1px, transparent 1px 3px)" }}
          />
          Not scouted
        </span>
        {heat && (
          <span className="hidden lg:inline">
            No action threshold yet — default bands on finds per scouted tree:
            medium from {fmt(heat.cuts.mid)}, high from {fmt(heat.cuts.high)}
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 px-4 pb-4 md:px-6 md:pb-6">
        <div className="relative h-full w-full min-h-0 overflow-hidden rounded-[20px] border border-border shadow-[var(--sd-shadow-1)]">
          <Map3D onReady={onMapReady} initialPitch={0} />

          {emptyMsg && (
            <div
              role="status"
              className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-card px-4 py-2 text-xs font-medium text-muted-foreground shadow-[var(--sd-shadow-2)]"
            >
              {emptyMsg}
            </div>
          )}

          <MapKpiPill>
            {first ? (
              <TextSkeleton width="24ch" />
            ) : (
              <>
                {heat
                  ? `${ranked.length} blocks · ${heat.samples} samples (${heat.hits} with ${obs?.name ?? "it"}${heat.traps ? `, ${heat.traps} traps` : ""})`
                  : "No located samples"}
              </>
            )}
          </MapKpiPill>

          <MapPanelDock>
          {planOpen && (
            // The plan is the working half of this page (a team, a kit, a
            // rate per chemical, the targets), so this one card is a little
            // wider than the standard 320px.
            <MapFloatingCard
              eyebrow="Plan"
              title={picked.length ? `${picked.length} selected` : "Affected blocks"}
              onClose={() => {
                if (picked.length) {
                  setPicked([]);
                  setSelected(null);
                  setPlanKey(null);
                } else setPlanOpen(false);
              }}
              className="w-[min(400px,calc(100%-2rem))]"
              closeLabel={picked.length ? "Clear selection" : "Close"}
              testId="plan-card"
            >
            <div aria-busy={first || undefined}>
              {first ? (
                  <RowsSkeleton rows={6} />
                ) : ranked.length ? (
                  <div ref={listRef} className={picked.length ? "max-h-52 overflow-y-auto" : undefined}>
                  {ranked.map((b) => (
                    <label
                      key={b.tag}
                      data-block={b.tag}
                      className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-muted"
                    >
                      <Checkbox checked={picked.includes(b.tag)} onCheckedChange={() => toggleBlock(b.tag)} />
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: FIELD_COLORS[heat ? classOf(b.mean, heat.cuts) : 0] }}
                        aria-hidden
                      />
                      <span className="flex-1 truncate" title={b.tag}>
                        {b.tag}
                      </span>
                      <span className="tabular-nums text-muted-foreground" title="Mean of the filled field · share of it in the red band">
                        {fmt(b.mean)} · {Math.round(b.redShare * 100)}% red
                      </span>
                    </label>
                  ))}
                  </div>
                ) : (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    No located samples for this observation
                  </div>
                )}
              {picked.length > 0 && (
                <div className="mt-2 space-y-3 border-t pt-2">
                  <BlockGroupsPanel
                    groups={groups}
                    areas={areas}
                    costCenters={bootCc}
                    activeKey={planKey}
                    onPlan={(g) => setPlanKey(groupKey(g))}
                  />
                </div>
              )}
              {selectedAgg && (
                <div className="space-y-3 p-1 text-xs">
                  <div className="border-t pt-2">
                    <div className="text-sm font-semibold">
                      {selectedAgg.block}
                    </div>
                    <div className="text-muted-foreground">
                      {selectedAgg.obs} observations · {selectedAgg.trees.size}{" "}
                      trees scouted
                      {(() => {
                        const ha = perHectare(
                          Array.from(selectedAgg.pests.values()).reduce((s, c) => s + c, 0),
                          blockAreas[selectedAgg.block],
                        );
                        return ha != null ? ` · ${ha} pests / ha` : "";
                      })()}
                    </div>
                  </div>

                  {/* Pests lead, ranked by pressure rather than by raw count,
                      and each is selectable: choosing what to spray for is the
                      first step of the rose flow and it belongs here too.
                      Diseases stay informational — the plan targets pests. */}
                  {[
                    {
                      title: "Top pests",
                      rows: rankedPests,
                      colorOf: pestColor,
                      selectable: true,
                    },
                    {
                      title: "Top diseases",
                      rows: topN(selectedAgg.diseases).map(
                        ([n, c]) => [n, c, null, null] as const,
                      ),
                      colorOf: diseaseColor,
                      selectable: false,
                    },
                  ].map((s) => (
                    <div key={s.title}>
                      <div className="mb-1 text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                        {s.title}
                      </div>
                      {s.rows.length ? (
                        s.rows.map(([name, count, band, judged]) => (
                          <label
                            key={name}
                            className={`flex items-center gap-2 rounded px-1.5 py-1 ${
                              s.selectable ? "cursor-pointer hover:bg-muted" : ""
                            }`}
                          >
                            {s.selectable ? (
                              <Checkbox
                                checked={targets.includes(name as string)}
                                onCheckedChange={(v) =>
                                  setTargets((t) =>
                                    v
                                      ? [...t, name as string]
                                      : t.filter((x) => x !== name),
                                  )
                                }
                              />
                            ) : (
                              <span
                                className="h-2.5 w-2.5 shrink-0 rounded-full border"
                                style={{ background: s.colorOf(name as string) }}
                                aria-hidden
                              />
                            )}
                            <span className="flex-1 truncate" title={name as string}>
                              {name}
                            </span>
                            {/* Only when a band was actually computed. Without a
                                threshold the "judged" figure is just the count
                                again, and printing "56.0  56" reads as two
                                different numbers that happen to agree. */}
                            {band && judged ? (
                              <span className="tabular-nums text-[0.65rem] text-muted-foreground">
                                {judgedLabel(judged as HouseFigure)}
                              </span>
                            ) : null}
                            {band ? (
                              <span
                                className="rounded-full px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide"
                                style={{
                                  background: `${BAND_COLOR[band as "high"]}22`,
                                  color: BAND_COLOR[band as "high"],
                                }}
                              >
                                {BAND_LABEL[band as "high"]}
                              </span>
                            ) : null}
                            <span className="w-8 text-right tabular-nums text-muted-foreground">
                              {count}
                            </span>
                          </label>
                        ))
                      ) : (
                        <div className="px-1.5 py-1 text-muted-foreground">None</div>
                      )}
                    </div>
                  ))}

                </div>
              )}
              {planGroup && (
                <div className="mt-2 border-t pt-2 text-xs">
                  <div className="mb-1 text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                    Plan spray
                  </div>
                  <BlockSprayPlan
                    key={groupKey(planGroup)}
                    blocks={planGroup}
                    targets={targets}
                    crop={filters.crop}
                  />
                </div>
              )}
            </div>
            </MapFloatingCard>
          )}
          </MapPanelDock>
        </div>
      </div>

    </div>
  );
}
