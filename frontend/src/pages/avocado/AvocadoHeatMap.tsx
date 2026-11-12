/**
 * Avocado/coffee Application Floor Plan — one page to observe and prescribe.
 *
 * The **map on the left** is a top-down (2D) view of the orchard showing ONE pest or disease
 * at a time (searchable pill). Every located scouting entry is a sample, zero where scouted
 * and not found; fixed-trap catches count for pests; the gaps are filled by inverse-distance
 * weighting (lib/idw.ts) across the block polygons and drawn as a canvas image, faded with
 * distance to the nearest scout.
 *
 * The **docked column on the right** is the open-field planner (OpenFieldPlanner): the block
 * list, one plan per selected block (each block is planned separately, with its own crop's
 * targets, tank mixes and rates), the draft Work Orders created in one all-or-nothing batch,
 * and the draft list. The map and the list pick the same blocks; clicking a block on the map
 * also opens a card over the map with its top pests and diseases.
 *
 * Quantities follow the block's hectarage where the product has a Hectarage rate for the
 * block's crop (lib/open-field), otherwise the water volume. The plans are ordinary
 * Application Floor Plans: same draft path, same approval, same transfer, with the block in
 * `custom_greenhouse`.
 */
import { parseNames } from "@/lib/places";
import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { ChevronDown, Layers } from "lucide-react";
import { useScouting } from "@/hooks/use-scouting";
import { MapFloatingCard } from "@/components/maps/MapFloatingCard";
import { MapKpiPill } from "@/components/maps/MapKpiPill";
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
import { OpenFieldPlanner } from "@/components/spray-plan/OpenFieldPlanner";
import { featureTag } from "@/lib/block-groups";
import type { OpenFieldGroup } from "@/lib/open-field";
import { BAND_LABEL, bandRank, judgedLabel, perHectare, type Band, type HouseFigure } from "@/lib/pest-bands";
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
import { ObservationMultiPicker, obsOptionKey as obsKey } from "@/components/ObservationMultiPicker";
import { computeMultiField, rankBlocks, type MultiField } from "@/lib/pest-heat-multi";

/** Band colours of the field: none/low, medium, high. */
const FIELD_COLORS: [string, string, string] = ["#5bb45d", "#e9a23b", "#dc2626"];
/** A block's name as scouting entries carry it (same match `selectBlock` uses). */
const blockTag = (p: any): string => p?.block || p?.block_label || p?.name || "";

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
  const ghList = useMemo(() => parseNames(filters.greenhouse), [filters.greenhouse]);
  const { data, loading, progress, error } = useScouting({
    from: filters.from,
    to: filters.to,
    greenhouses: ghList.length ? ghList : undefined,
    crop: filters.crop,
  });

  const [blocks, setBlocks] = useState<GeoJsonFC | null>(null);
  const [treePoints, setTreePoints] = useState<OrchardTreePoints | null>(null);
  const [loadingGeo, setLoadingGeo] = useState(false);
  const [showBoundary, setShowBoundary] = useState(false);
  const [showTrees, setShowTrees] = useState(true);
  // Block areas, for count per hectare.
  const [blockAreas, setBlockAreas] = useState<Record<string, number>>({});
  // Blocks picked for spraying: the same list the planning column ticks, in pick order.
  const [picked, setPicked] = useState<string[]>([]);
  // A block to bring into view in that list (picked on the map).
  const [focus, setFocus] = useState<string | null>(null);
  // The blocks the user may plan on (the map only adds these to the plan).
  const [plannable, setPlannable] = useState<Set<string>>(new Set());
  // The block whose card is open over the map.
  const [detail, setDetail] = useState<string | null>(null);
  // The pests and diseases the field shows (null = all of them, so ones seen
  // later in the window join in).
  const [pickedObs, setPickedObs] = useState<Set<string> | null>(null);
  const [fixedTraps, setFixedTraps] = useState<TrapLocations>({});

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

  useEffect(() => {
    let cancelled = false;
    void fetchTrapLocations(filters.farm === ALL ? undefined : filters.farm).then((t) => {
      if (!cancelled) setFixedTraps(t);
    });
    return () => {
      cancelled = true;
    };
  }, [filters.farm]);

  // The observations seen in the window; the field shows the selected ones.
  const obsOptions = useMemo(() => (data ? observationOptions(data.entries) : []), [data]);
  const selected = useMemo(
    () => (pickedObs ? obsOptions.filter((o) => pickedObs.has(obsKey(o))) : obsOptions),
    [obsOptions, pickedObs],
  );
  const selectedKeys = useMemo(() => new Set(selected.map(obsKey)), [selected]);
  // Exactly one selected keeps the single-pest field; several colour by the worst of them.
  const obs: ObsOption | null = selected.length === 1 ? selected[0] : null;
  const multi = selected.length > 1;
  const obsLabel = obs ? obs.name : multi ? `${selected.length} pests and diseases` : "";
  const onPick = (next: Set<string>) =>
    setPickedObs(obsOptions.length > 0 && obsOptions.every((o) => next.has(obsKey(o))) ? null : next);

  // The field: every located entry is a sample (0 where scouted and not found),
  // IDW-filled across the block polygons.
  const fieldResult: MultiField | ReturnType<typeof computeField> | null = useMemo(() => {
    if (!data || !blocks || !selected.length) return null;
    if (selected.length === 1)
      return computeField(data.entries, selected[0], blocks, fixedTraps, blockTag, FIELD_COLORS);
    return computeMultiField(
      data.entries, selected, blocks, fixedTraps, blockTag,
      (o) => (o.kind === "pest" ? pestColor(o.name) : diseaseColor(o.name)), FIELD_COLORS[0],
    );
  }, [data, selected, blocks, fixedTraps, pestColor, diseaseColor]);
  const heat = fieldResult?.kind === "ok" ? fieldResult : null;
  // Why the map is blank, said plainly (coffee blocks may not be keyed in yet).
  const emptyMsg =
    !data || loading || loadingGeo || !blocks
      ? null
      : blocks.features.length === 0 || fieldResult?.kind === "no-blocks"
        ? "No blocks mapped for this crop yet"
        : !selected.length
          ? "Pick at least one pest or disease"
          : fieldResult?.kind === "no-samples"
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
  const ranked = useMemo(() => rankBlocks(heat?.blocks ?? []), [heat]);
  const multiHeat = heat && "share" in heat ? (heat as Extract<MultiField, { kind: "ok" }>) : null;
  const dominantOf = (tag: string) => multiHeat?.dominant.get(tag);
  const detailAgg = useMemo(
    () => blockAggs.find((b) => b.block === detail) || null,
    [blockAggs, detail],
  );

  // Each pest of the selected block, judged on the server exactly as the
  // alerts and the weekly sheet judge it (thresholds D8).
  const houseFigs = useHouseFigures(filters.crop, detail, filters.from, filters.to);

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
      map.on("click", "blocks-fill", (e) => {
        const tag = blockTag(e.features?.[0]?.properties);
        if (tag) pickOnMapRef.current(tag);
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

  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const plannableRef = useRef(plannable);
  plannableRef.current = plannable;

  const flyToBlock = (block: string) => {
    const map = mapRef.current;
    const f = (blocksRef.current?.features ?? []).filter((x) => featureTag(x) === block);
    const bb = allBlocksBounds({ type: "FeatureCollection", features: f } as GeoJsonFC);
    if (map && bb) map.fitBounds(bb, { padding: 140, duration: 800, maxZoom: 18 });
  };
  /** From the list: a single new pick is flown to; the list scrolls to it. */
  const onListSelect = (next: string[]) => {
    const added = next.filter((n) => !pickedRef.current.includes(n));
    setPicked(next);
    if (added.length === 1) {
      setFocus(added[0]);
      setDetail(added[0]);
      flyToBlock(added[0]);
    }
  };
  /** From the map: a plannable block joins the plan; the card opens either way. */
  const pickOnMap = (block: string) => {
    if (plannableRef.current.has(block) && !pickedRef.current.includes(block)) setPicked([...pickedRef.current, block]);
    setFocus(block);
    setDetail(block);
  };
  const pickOnMapRef = useRef(pickOnMap);
  pickOnMapRef.current = pickOnMap;
  const togglePick = (block: string) =>
    setPicked((p) => (p.includes(block) ? p.filter((b) => b !== block) : [...p, block]));

  // Outline + light fill for the picks.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !blocks) return;
    const on = new Set(picked);
    (map.getSource("block-sel") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: blocks.features.filter((f) => on.has(featureTag(f))),
    } as never);
  }, [picked, blocks, mapReady]);

  const topN = (m: Map<string, number>, n = 5) =>
    Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);

  // Pests for the selected block, ranked by the band the server judged — the
  // pest furthest over its threshold leads, not merely the biggest count. A pest
  // with no band keeps its place by count rather than being dropped.
  const rankedPests = useMemo(() => {
    if (!detailAgg) return [] as Array<readonly [string, number, Band, HouseFigure | null]>;
    return Array.from(detailAgg.pests.entries())
      .map(([name, count]) => {
        const f = houseFigs[name] ?? null;
        return [name, count, f?.band ?? null, f] as const;
      })
      .sort((a, b) => bandRank(b[2]) - bandRank(a[2]) || b[1] - a[1])
      .slice(0, 8);
  }, [detailAgg, houseFigs]);

  // First load (no scouting processed yet): the legend stays, the counts are skeletons.
  // A failed load ends the skeletons and says so (below), rather than pulsing on.
  const first = firstLoad(loading || (!data && !error), !!data);

  return (
    <div className="flex h-svh flex-col overflow-y-auto lg:overflow-hidden">
      <MapHeader
        title="Application Floor Plan"
        subtitle={obsLabel ? `${obsLabel} · select blocks on the map or in the list, plan each` : "Pest & disease, then the plan"}
        value={filters}
        onChange={setFilters}
        showGreenhouse={false}
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
                <Checkbox checked={showTrees} onCheckedChange={(v) => setShowTrees(!!v)} />
                Trees
              </label>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-muted">
                <Checkbox checked={showBoundary} onCheckedChange={(v) => setShowBoundary(!!v)} />
                Boundary
              </label>
            </PopoverContent>
          </Popover>
        }
      />

      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2 text-xs text-muted-foreground md:px-6" data-testid="heat-legend">
        {/* Was a full-screen overlay; inline here so the map shows through. */}
        {error && !data && !loading && (
          <span role="alert" className="text-destructive">{error}</span>
        )}
        <LoadProgress active={loading || loadingGeo} progress={loading ? progress : 100} />
        <ObservationMultiPicker options={obsOptions} value={selectedKeys} onChange={onPick} />
        {multi && multiHeat ? (
          <>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: FIELD_COLORS[0] }} /> None / low
            </span>
            {selected
              .filter((o) => multiHeat.share.has(obsKey(o)))
              .sort((a, b) => (multiHeat.share.get(obsKey(b)) || 0) - (multiHeat.share.get(obsKey(a)) || 0))
              .slice(0, 6)
              .map((o) => (
                <span key={obsKey(o)} className="flex items-center gap-1.5" data-testid="legend-obs">
                  <span className="h-2 w-2 rounded-full" style={{ background: o.kind === "pest" ? pestColor(o.name) : diseaseColor(o.name) }} />
                  {o.name}
                </span>
              ))}
            <span>Each patch takes the colour of the worst selected observation there; stronger means higher.</span>
          </>
        ) : (
          [
            ["None / low", FIELD_COLORS[0]],
            ["Medium", FIELD_COLORS[1]],
            ["High", FIELD_COLORS[2]],
          ].map(([label, c]) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: c }} /> {label}
          </span>
        ))
        )}
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

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4 pt-3 md:px-6 md:pb-6 lg:flex-row">
        <div
          className="relative min-h-[420px] w-full flex-1 overflow-hidden rounded-[20px] border border-border shadow-[var(--sd-shadow-1)] lg:min-h-0"
          data-testid="plan-map"
        >
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
            ) : heat ? (
              `${ranked.length} blocks · ${heat.samples} samples (${heat.hits} with ${obsLabel || "it"}${heat.traps ? `, ${heat.traps} traps` : ""})`
            ) : (
              "No located samples"
            )}
          </MapKpiPill>

          {detail && (
            <MapFloatingCard eyebrow="Block" title={detail} onClose={() => setDetail(null)} testId="map-detail-card">
              <div className="space-y-3 text-xs">
                {detailAgg ? (
                  <div className="text-muted-foreground">
                    {detailAgg.obs} observations · {detailAgg.trees.size} trees scouted
                    {(() => {
                      const ha = perHectare(
                        Array.from(detailAgg.pests.values()).reduce((s, c) => s + c, 0),
                        blockAreas[detailAgg.block],
                      );
                      return ha != null ? ` · ${ha} pests / ha` : "";
                    })()}
                  </div>
                ) : (
                  <div className="text-muted-foreground">No scouting in this window</div>
                )}
                {detailAgg && (
                  <div>
                    <div className="mb-1 text-[0.7rem] uppercase tracking-wide text-muted-foreground">Top pests</div>
                    {rankedPests.length ? (
                      rankedPests.map(([name, count, band, judged]) => (
                        <div key={name} className="flex items-center gap-2 px-1.5 py-1">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ background: pestColor(name) }} aria-hidden />
                          <span className="flex-1 truncate" title={name}>{name}</span>
                          {band && judged ? (
                            <span className="tabular-nums text-[0.65rem] text-muted-foreground">{judgedLabel(judged as HouseFigure)}</span>
                          ) : null}
                          {band ? (
                            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide">
                              {BAND_LABEL[band as "high"]}
                            </span>
                          ) : null}
                          <span className="w-8 text-right tabular-nums text-muted-foreground">{count}</span>
                        </div>
                      ))
                    ) : (
                      <div className="px-1.5 py-1 text-muted-foreground">None</div>
                    )}
                    <div className="mb-1 mt-2 text-[0.7rem] uppercase tracking-wide text-muted-foreground">Top diseases</div>
                    {detailAgg.diseases.size ? (
                      topN(detailAgg.diseases).map(([name, count]) => (
                        <div key={name} className="flex items-center gap-2 px-1.5 py-1">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ background: diseaseColor(name) }} aria-hidden />
                          <span className="flex-1 truncate" title={name}>{name}</span>
                          <span className="w-8 text-right tabular-nums text-muted-foreground">{count}</span>
                        </div>
                      ))
                    ) : (
                      <div className="px-1.5 py-1 text-muted-foreground">None</div>
                    )}
                  </div>
                )}
                {plannable.has(detail) && (
                  <Button
                    size="sm"
                    variant={picked.includes(detail) ? "outline" : "default"}
                    className="w-full rounded-full"
                    onClick={() => togglePick(detail)}
                  >
                    {picked.includes(detail) ? "Remove from the plan" : "Add to the plan"}
                  </Button>
                )}
              </div>
            </MapFloatingCard>
          )}
        </div>

        <aside
          className="w-full shrink-0 lg:w-[min(460px,40%)] lg:min-h-0 lg:overflow-y-auto lg:pr-1"
          data-testid="plan-column"
          aria-label="Plan"
        >
          <OpenFieldPlanner
            crop={filters.crop}
            selected={picked}
            onSelect={onListSelect}
            focus={focus}
            onBlocks={(gs: OpenFieldGroup[]) => setPlannable(new Set(gs.flatMap((g) => g.blocks.map((b) => b.name))))}
            rowExtra={(b) => {
              const r = ranked.find((x) => x.tag === b.name);
              if (!r || !heat) return null;
              const domKey = dominantOf(b.name);
              const dom = domKey ? selected.find((o) => obsKey(o) === domKey) : undefined;
              return (
                <span
                  className="flex items-center gap-1 text-[0.65rem] tabular-nums text-muted-foreground"
                  title={`${dom ? `${dom.name} is the worst of ${obsLabel} on this block: ` : `${obs?.name ?? ""} on this block: `}mean of the filled field, ${Math.round(r.redShare * 100)}% in the red band`}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    data-testid="row-heat"
                    style={{
                      background: dom
                        ? dom.kind === "pest" ? pestColor(dom.name) : diseaseColor(dom.name)
                        : FIELD_COLORS[classOf(r.mean, heat.cuts)],
                    }}
                    aria-hidden
                  />
                  {dom && <span className="max-w-[5rem] truncate">{dom.name}</span>}
                  {fmt(r.mean)}
                </span>
              );
            }}
          />
        </aside>
      </div>
    </div>
  );
}
