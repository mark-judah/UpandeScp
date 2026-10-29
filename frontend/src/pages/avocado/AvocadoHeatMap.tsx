/**
 * Open-field Application Plan (block-grown crops: avocado, pivot crops, coffee) — spec 2026-10-29.
 *
 * One page to observe and prescribe: the **map on the left** shows ONE pest or disease at a time
 * (searchable pill) in that observation's own colour, intensity as opacity (lib/pest-tone, the
 * roses heat-style levels); the **docked column on the right** is the open-field planner
 * (OpenFieldPlanner: block list → one plan per selected block → drafts in one batch → the draft
 * list). The map and the list pick the same blocks. Clicking a block, a hexagon or a trap opens an
 * undocked card over the map with its details.
 *
 * Each block paints its heat by its Heat Style (Warehouse.custom_heat_style; blank = by kind):
 * Smear blocks get the inverse-distance field (lib/idw.ts) across their polygons, faded with the
 * distance to the nearest scout; Solid blocks fill each hexagon (and wash the block when zoomed
 * out). Traps sit on the unit they hang on (outlined, numbered, pulsing by catch). The 3D switch
 * tilts the map and raises a sphere per scouting value (SpheresLayer).
 *
 * The plans it creates are ordinary draft Work Orders, one per block (create_draft_plans_batch).
 */
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HEADER_PILL } from "@/components/header-controls";
import { OpenFieldPlanner } from "@/components/spray-plan/OpenFieldPlanner";
import { TrapReadingCard } from "@/components/traps/TrapReadingCard";
import { featureTag } from "@/lib/block-groups";
import { BAND_LABEL, bandRank, judgedLabel, perHectare, type Band, type HouseFigure } from "@/lib/pest-bands";
import { useHouseFigures } from "@/hooks/use-house-figures";
import { ALL, MapHeader, type MapFilterValue } from "../maps/MapHeader";
import {
  fetchBlockAreas,
  fetchBlocksGeojson,
  fetchOrchardTreeRows,
  fetchTrapLocations,
  type GeoJsonFC,
  type OrchardTreePoints,
  type TrapLocations,
} from "@/lib/scouting-api";
import { BLOCK_MAP_MONTHS, lastMonthsRange } from "@/lib/utils";
import { useObservationColors } from "@/lib/observation-colors";
import { classOf } from "@/lib/idw";
import { computeField, FIELD_RADIUS_M, observationOptions, type ObsOption } from "@/lib/pest-heat";
import { FIELD_ALPHAS, rgbOf, splitByHeatStyle, toneBands, toneOf } from "@/lib/pest-tone";
import { trapPlacement, trapUnitLayers } from "@/lib/trap-units";
import { TRAP_FOCUS_ZOOM } from "@/lib/trap-pulse";
import { unitKey } from "@/lib/unit-key";
import { triadObsColors } from "@/lib/triad-colors";
import { ObservationPicker, obsKey } from "./ObservationPicker";
import { addFieldLayers, blockColors, paintFieldColors, pointFeatures, setFieldVisibility } from "../maps/field-layers";
import { addTrapMarkers, drawTrapUnits, flyToTrap } from "../maps/trap-layers";
import { SpheresLayer } from "../maps/SpheresLayer";
import { spherePoints } from "../maps/sphere-data";
import { decodeHexes, fetchFieldLayers, rowLines, type FieldLayersPayload } from "@/lib/field-geo";
import { deriveTrapMarkers } from "./derive-traps";
import type { MarkerPoint } from "./tree-map-types";
import type { OpenFieldGroup } from "@/lib/open-field";

/** A block's name as scouting entries carry it. */
const blockTag = (p: any): string => p?.block || p?.block_label || p?.name || "";
/** Pitch of the 3D view. */
const TILT = 55;
/** Neutral colour while no observation is picked. */
const NO_OBS = "#5a5a54";

const fmt = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "-");
const hexOf = (c: string) => {
  const rgb = rgbOf(c);
  return rgb ? `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}` : NO_OBS;
};

type Ring = [number, number][];
function ringsOf(g: any): Ring[] {
  if (g?.type === "Polygon") return [g.coordinates?.[0]].filter(Boolean);
  if (g?.type === "MultiPolygon") return (g.coordinates || []).map((p: any) => p?.[0]).filter(Boolean);
  return [];
}
function boundsOf(features: Array<{ geometry: any }>): [[number, number], [number, number]] | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of features)
    for (const ring of ringsOf(f.geometry))
      for (const c of ring) {
        minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]);
        minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
      }
  return Number.isFinite(minX) ? [[minX, minY], [maxX, maxY]] : null;
}

interface BlockAgg {
  block: string;
  obs: number;
  trees: Set<string>;
  pests: Map<string, number>;
  diseases: Map<string, number>;
}

/** What the undocked card over the map shows. */
type Detail =
  | { kind: "block"; block: string }
  | { kind: "hex"; unit: string; block: string }
  | { kind: "trap"; marker: MarkerPoint };

export function AvocadoHeatMap({ initialCrop = "Avocado" }: { initialCrop?: string } = {}) {
  const [filters, setFilters] = useState<MapFilterValue>(() => ({
    crop: initialCrop,
    farm: ALL,
    greenhouse: ALL,
    // Crop-scoped, a week per request: open on the last quarter, widen with the range.
    ...lastMonthsRange(BLOCK_MAP_MONTHS),
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
  const [showBoundary, setShowBoundary] = useState(true);
  const [showHex, setShowHex] = useState(true);
  const [showTrees, setShowTrees] = useState(true);
  const [showTraps, setShowTraps] = useState(true);
  const [view3d, setView3d] = useState(false);
  const [field, setField] = useState<FieldLayersPayload | null>(null);
  const paintedRef = useRef<{ units: Map<string, string> | null; blocks: Map<string, string> | null }>({ units: null, blocks: null });
  const [blockAreas, setBlockAreas] = useState<Record<string, number>>({});
  // Blocks picked for spraying — the same list the planning column ticks.
  const [picked, setPicked] = useState<string[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const [plannable, setPlannable] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Detail | null>(null);
  const [pickedObs, setPickedObs] = useState<string | null>(null);
  const [traps, setTraps] = useState<TrapLocations>({});

  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const { pest: pestColor, disease: diseaseColor } = useObservationColors();

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
      .then((b) => setBlocks({ ...b, features: (b.features || []).filter((f) => !!f.geometry) }))
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
  // Rows and hexagons: compact, versioned, cached locally; drawn only once zoomed in.
  useEffect(() => {
    let alive = true;
    fetchFieldLayers(filters.farm === ALL ? "" : filters.farm)
      .then((r) => alive && setField(r))
      .catch(() => alive && setField(null));
    return () => {
      alive = false;
    };
  }, [filters.farm]);
  const hexSet = useMemo(() => decodeHexes(field?.hex), [field]);
  const hexBlocks = useMemo(() => new Set(hexSet.fc.features.map((f) => f.properties.b)), [hexSet]);

  useEffect(() => {
    let cancelled = false;
    void fetchTrapLocations(filters.farm === ALL ? undefined : filters.farm).then((t) => {
      if (!cancelled) setTraps(t);
    });
    return () => {
      cancelled = true;
    };
  }, [filters.farm]);

  // The observations seen in the window; the map shows one of them.
  const obsOptions = useMemo(() => (data ? observationOptions(data.entries) : []), [data]);
  const obs: ObsOption | null =
    obsOptions.find((o) => obsKey(o) === pickedObs) ??
    obsOptions.find((o) => o.kind === "pest" && o.count > 0) ??
    obsOptions[0] ??
    null;
  // The observation's own colour; its tones (low, medium, high, clean) paint every unit.
  const obsColor = obs ? hexOf(obs.kind === "pest" ? pestColor(obs.name) : diseaseColor(obs.name)) : NO_OBS;
  const tones = useMemo(() => toneBands(obsColor), [obsColor]);

  // Smear blocks feed the field; Solid blocks are painted per hexagon / unit.
  const styles = useMemo(() => (blocks ? splitByHeatStyle(blocks, hexBlocks) : null), [blocks, hexBlocks]);
  const fieldResult = useMemo(
    () =>
      data && obs && styles && styles.smear.features.length
        ? computeField(data.entries, obs, styles.smear, traps, blockTag, [obsColor, obsColor, obsColor], FIELD_ALPHAS)
        : null,
    [data, obs, styles, traps, obsColor],
  );
  const heat = fieldResult?.kind === "ok" ? fieldResult : null;
  const solidEntries = useMemo(
    () => (data && styles ? data.entries.filter((e) => e.block && styles.solid.has(e.block)) : []),
    [data, styles],
  );
  const unitTones = useMemo(() => triadObsColors(solidEntries, obs, tones, unitKey), [solidEntries, obs, tones]);
  const solidBlockTones = useMemo(() => blockColors(solidEntries, unitTones), [solidEntries, unitTones]);

  // Why the map is blank, said plainly.
  const emptyMsg =
    !data || loading || loadingGeo || !blocks
      ? null
      : blocks.features.length === 0
        ? "No blocks mapped for this crop yet"
        : !obs
          ? "No geo-tagged scouting for this crop in this window"
          : null;

  // Faint tree dots for orientation under the heat field.
  const treeFC = useMemo(() => {
    const features: any[] = [];
    const p = treePoints;
    if (p)
      for (let i = 0; i < p.names.length; i++)
        features.push({ type: "Feature", geometry: { type: "Point", coordinates: [p.coords[i * 2], p.coords[i * 2 + 1]] }, properties: {} });
    return { type: "FeatureCollection", features } as const;
  }, [treePoints]);

  // Per-block findings, for the block card.
  const blockAggs = useMemo(() => {
    const m = new Map<string, BlockAgg>();
    for (const e of data?.entries ?? []) {
      if (!e.block) continue;
      let a = m.get(e.block);
      if (!a) m.set(e.block, (a = { block: e.block, obs: 0, trees: new Set(), pests: new Map(), diseases: new Map() }));
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
    }
    return m;
  }, [data]);

  // Each block's heat for the list: the smear's mean and band, or the solid wash.
  const blockHeat = useMemo(() => {
    const m = new Map<string, { tone: string; label: string }>();
    for (const b of heat?.blocks ?? [])
      if (b.tag && b.coverage > 0) m.set(b.tag, { tone: toneOf(obsColor, classOf(b.mean, heat!.cuts)), label: fmt(b.mean) });
    for (const [b, tone] of solidBlockTones) if (!m.has(b)) m.set(b, { tone, label: "" });
    return m;
  }, [heat, solidBlockTones, obsColor]);

  // Traps: one pulsing marker per trap (size by catch, the pest's colour), on its unit.
  const trapMarkers = useMemo(() => deriveTrapMarkers(data, traps, pestColor), [data, traps, pestColor]);

  const detailBlock = detail?.kind === "block" ? detail.block : detail?.kind === "hex" ? detail.block : null;
  const detailAgg = detailBlock ? blockAggs.get(detailBlock) ?? null : null;
  const houseFigs = useHouseFigures(filters.crop, detail?.kind === "block" ? detail.block : null, filters.from, filters.to);

  // ---------------------------------------------------------------- picking

  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const plannableRef = useRef(plannable);
  plannableRef.current = plannable;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  const flyToBlock = (block: string) => {
    const map = mapRef.current;
    const f = blocksRef.current?.features.filter((x) => featureTag(x) === block) ?? [];
    const b = boundsOf(f);
    if (map && b) map.fitBounds(b, { padding: 80, duration: 800, maxZoom: 18 });
  };
  /** From the list: the new pick is flown to (the first one) and brought into view. */
  const onListSelect = (next: string[]) => {
    const added = next.filter((n) => !pickedRef.current.includes(n));
    setPicked(next);
    if (added.length === 1) {
      setFocus(added[0]);
      flyToBlock(added[0]);
    }
  };
  /** From the map: a plannable block joins the plan; the card opens either way. */
  const pickOnMap = (block: string) => {
    if (plannableRef.current.has(block) && !pickedRef.current.includes(block)) setPicked([...pickedRef.current, block]);
    setFocus(block);
  };
  const togglePick = (block: string) =>
    setPicked((p) => (p.includes(block) ? p.filter((b) => b !== block) : [...p, block]));
  const clickRef = useRef<(e: maplibregl.MapMouseEvent) => void>(() => {});
  clickRef.current = (e) => {
    const map = mapRef.current;
    if (!map) return;
    const layers = ["fg-hex-fill", "blocks-fill"].filter((id) => map.getLayer(id));
    const hits = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : [];
    const hex = hits.find((f) => f.layer?.id === "fg-hex-fill");
    if (hex) {
      const p = hex.properties as { n?: string; b?: string };
      if (p.n) {
        setDetail({ kind: "hex", unit: p.n, block: p.b || "" });
        return;
      }
    }
    const blk = hits.find((f) => f.layer?.id === "blocks-fill");
    const tag = blk ? blockTag(blk.properties) : "";
    if (!tag) return;
    pickOnMap(tag);
    setDetail({ kind: "block", block: tag });
  };
  const openTrapRef = useRef<(m: MarkerPoint) => void>(() => {});
  openTrapRef.current = (m) => {
    const map = mapRef.current;
    if (!map) return;
    setDetail(null);
    flyToTrap(map, m, TRAP_FOCUS_ZOOM, () => setDetail({ kind: "trap", marker: m }));
  };

  const onMapReady = (map: maplibregl.Map) => {
    mapRef.current = map;
    map.on("load", () => setMapReady(true));
    map.on("click", (e) => clickRef.current(e));
  };

  // ---------------------------------------------------------------- map layers

  // The smear: the IDW grid as a canvas image over its bounding box, under the tree dots.
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
        { id: "heat", type: "raster", source: "heat", paint: { "raster-opacity": 1, "raster-fade-duration": 0, "raster-resampling": "linear" } },
        map.getLayer("tree-dots") ? "tree-dots" : undefined,
      );
    } else {
      src.updateImage({ url, coordinates });
      map.setLayoutProperty("heat", "visibility", "visible");
    }
  }, [heat, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (!map.getSource("tree-dots")) {
      map.addSource("tree-dots", { type: "geojson", data: treeFC as never });
      map.addLayer({
        id: "tree-dots",
        type: "circle",
        source: "tree-dots",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 0.8, 17, 2, 20, 3.5],
          "circle-color": "rgba(58,58,52,0.35)",
        },
      });
    } else (map.getSource("tree-dots") as maplibregl.GeoJSONSource).setData(treeFC as never);
  }, [treeFC, mapReady]);

  // Block outlines (+ an invisible fill as the click target) and the picks' highlight.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !blocks) return;
    if (!map.getSource("blocks")) {
      map.addSource("blocks", { type: "geojson", data: blocks as never, promoteId: "block" });
      map.addLayer({ id: "blocks-fill", type: "fill", source: "blocks", paint: { "fill-color": "#000000", "fill-opacity": 0 } });
      map.addLayer({ id: "blocks-line", type: "line", source: "blocks", paint: { "line-color": "#2a2a26", "line-width": 1.25, "line-opacity": 0.4 } });
      map.on("mouseenter", "blocks-fill", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "blocks-fill", () => (map.getCanvas().style.cursor = ""));
    } else (map.getSource("blocks") as maplibregl.GeoJSONSource).setData(blocks as never);
    if (!map.getSource("block-sel")) {
      map.addSource("block-sel", { type: "geojson", data: { type: "FeatureCollection", features: [] } as never });
      map.addLayer({ id: "block-sel-fill", type: "fill", source: "block-sel", paint: { "fill-color": "#d9a514", "fill-opacity": 0.12 } });
      map.addLayer({ id: "block-sel-halo", type: "line", source: "block-sel", paint: { "line-color": "#ffffff", "line-width": 6, "line-opacity": 0.9 } });
      map.addLayer({ id: "block-sel", type: "line", source: "block-sel", paint: { "line-color": "#d9a514", "line-width": 3, "line-opacity": 1 } });
    }
  }, [blocks, mapReady]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !blocks) return;
    const on = new Set(picked);
    (map.getSource("block-sel") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: blocks.features.filter((f) => on.has(featureTag(f))),
    } as never);
  }, [picked, blocks, mapReady]);

  // Hexagons, rows and visit points under the outlines; Solid blocks painted per unit.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !blocks || !field) return;
    addFieldLayers(map, hexSet, rowLines(field.rows, field.hex.q), [...hexBlocks]);
    paintedRef.current = { units: null, blocks: null };
    setFieldVisibility(map, { hex: showHex, rows: showHex });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, hexSet, blocks, mapReady]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !map.getSource("fg-hex")) return;
    paintFieldColors(map, hexSet, paintedRef.current.units, unitTones, { prev: paintedRef.current.blocks, next: solidBlockTones });
    paintedRef.current = { units: unitTones, blocks: solidBlockTones };
    (map.getSource("fg-pts") as maplibregl.GeoJSONSource | undefined)?.setData(pointFeatures(solidEntries, unitTones) as never);
  }, [unitTones, solidBlockTones, solidEntries, hexSet, field, mapReady]);
  useEffect(() => {
    const map = mapRef.current;
    if (map && mapReady) setFieldVisibility(map, { hex: showHex, rows: showHex });
  }, [showHex, mapReady, field]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const setVis = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    setVis("blocks-line", showBoundary);
    setVis("tree-dots", showTrees);
  }, [showBoundary, showTrees, mapReady]);

  // Traps on their units, numbered; pulsing markers above.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const colors = Object.fromEntries(trapMarkers.filter((m) => m.label && m.count > 0).map((m) => [m.label!, m.color]));
    drawTrapUnits(map, trapUnitLayers(traps, colors), showTraps);
    if (!showTraps) return;
    const made = addTrapMarkers(map, trapMarkers, (m) => openTrapRef.current(m));
    return () => made.forEach((mk) => mk.remove());
  }, [traps, trapMarkers, showTraps, mapReady]);

  // 3D: tilt and raise a sphere per scouting value; 2D: flat, no spheres.
  const spheresRef = useRef<SpheresLayer | null>(null);
  const spheres = useMemo(() => {
    if (!view3d || !data) return [];
    const centres = new Map<string, [number, number]>();
    return spherePoints(data.entries, obs, (k) => {
      const hit = centres.get(k);
      if (hit) return hit;
      const id = hexSet.idByName.get(k);
      const f = id == null ? null : hexSet.fc.features[id];
      const ring = f?.geometry.coordinates[0];
      if (!ring?.length) return null;
      const pts = ring.slice(0, -1);
      const c: [number, number] = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
      centres.set(k, c);
      return c;
    });
  }, [view3d, data, obs, hexSet]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (!view3d) {
      if (map.getLayer("scouting-spheres")) map.removeLayer("scouting-spheres");
      spheresRef.current = null;
      if (map.getPitch() !== 0) map.easeTo({ pitch: 0, duration: 600 });
      return;
    }
    if (spheresRef.current && map.getLayer("scouting-spheres")) spheresRef.current.update(spheres, obsColor);
    else {
      spheresRef.current = new SpheresLayer(spheres, obsColor);
      map.addLayer(spheresRef.current);
    }
    if (map.getPitch() < TILT - 1) map.easeTo({ pitch: TILT, duration: 600 });
  }, [view3d, spheres, obsColor, mapReady]);

  // Fit to the farm's blocks on load / farm change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !blocks) return;
    const feats = filters.farm === ALL ? blocks.features : blocks.features.filter((f) => f.properties?.farm === filters.farm);
    const b = boundsOf(feats.length ? feats : blocks.features);
    if (b) map.fitBounds(b, { padding: 60, duration: 800 });
  }, [blocks, mapReady, filters.farm]);

  // A trap gone from the data closes its card.
  useEffect(() => {
    setDetail((d) => (d?.kind === "trap" && !trapMarkers.some((m) => m.label === d.marker.label) ? null : d));
  }, [trapMarkers]);

  // ---------------------------------------------------------------- the block / hexagon card

  const rankedPests = useMemo(() => {
    if (!detailAgg) return [] as Array<readonly [string, number, Band, HouseFigure | null]>;
    return Array.from(detailAgg.pests.entries())
      .map(([name, count]) => {
        const f = houseFigs[name] ?? null;
        return [name, count, f?.band ?? null, f] as const;
      })
      .sort((a, b) => bandRank(b[2]) - bandRank(a[2]) || b[1] - a[1])
      .slice(0, 6);
  }, [detailAgg, houseFigs]);
  const hexVisits = useMemo(
    () => (detail?.kind === "hex" && data ? data.entries.filter((e) => e.triad === detail.unit) : []),
    [detail, data],
  );

  const first = firstLoad(loading || (!data && !error), !!data);
  const detailTitle = detail?.kind === "block" ? detail.block : detail?.kind === "hex" ? detail.unit.split(" - ").slice(-2).join(" · ") : "";

  return (
    <div className="flex h-svh flex-col overflow-y-auto lg:overflow-hidden">
      <MapHeader
        title="Application Plan"
        subtitle={obs ? `${obs.name} · select blocks on the map or in the list, plan each` : "Pest & disease, then the plan"}
        value={filters}
        onChange={setFilters}
        showGreenhouse={false}
        rightSlot={
          <>
            <div className={`${HEADER_PILL} gap-0 overflow-hidden !p-0`} role="group" aria-label="Map view">
              {(["2D", "3D"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={(v === "3D") === view3d}
                  onClick={() => setView3d(v === "3D")}
                  className={`px-3 py-1 text-xs ${(v === "3D") === view3d ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                >
                  {v}
                </button>
              ))}
            </div>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className={HEADER_PILL}>
                  <Layers className="h-3.5 w-3.5" />
                  Layers
                  <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-44 p-2">
                {(
                  [
                    ["Trees", showTrees, setShowTrees],
                    ["Boundary", showBoundary, setShowBoundary],
                    ["Hexagons & rows", showHex, setShowHex],
                    ["Traps", showTraps, setShowTraps],
                  ] as const
                ).map(([label, on, set]) => (
                  <label key={label} className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-muted">
                    <Checkbox checked={on} onCheckedChange={(v) => set(!!v)} />
                    {label}
                  </label>
                ))}
              </PopoverContent>
            </Popover>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2 text-xs text-muted-foreground md:px-6" data-testid="heat-legend">
        {error && !data && !loading && (
          <span role="alert" className="text-destructive">{error}</span>
        )}
        <LoadProgress active={loading || loadingGeo} progress={loading ? progress : 100} />
        <ObservationPicker options={obsOptions} value={obs} onChange={(o) => setPickedObs(obsKey(o))} />
        {(["Low", "Medium", "High"] as const).map((label, i) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full border border-black/10" data-tone={label} style={{ background: tones[i] }} /> {label}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-full" style={{ background: `linear-gradient(90deg, ${tones[1]}, transparent)` }} />
          Estimated (no scout within {FIELD_RADIUS_M} m)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-sm" style={{ background: "repeating-linear-gradient(135deg, rgba(90,90,84,0.5) 0 1px, transparent 1px 3px)" }} />
          Not scouted
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4 pt-3 md:px-6 md:pb-6 lg:flex-row">
        <div
          className="relative min-h-[420px] w-full flex-1 overflow-hidden rounded-[20px] border border-border shadow-[var(--sd-shadow-1)] lg:min-h-0"
          data-testid="plan-map"
        >
          <Map3D onReady={onMapReady} initialPitch={0} />

          {emptyMsg && (
            <div role="status" className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-card px-4 py-2 text-xs font-medium text-muted-foreground shadow-[var(--sd-shadow-2)]">
              {emptyMsg}
            </div>
          )}

          <MapKpiPill>
            {first ? (
              <TextSkeleton width="24ch" />
            ) : heat ? (
              `${heat.samples} samples (${heat.hits} with ${obs?.name ?? "it"}${heat.traps ? `, ${heat.traps} traps` : ""})${view3d ? ` · ${spheres.length} spheres` : ""}`
            ) : (
              `${unitTones.size} units scouted${view3d ? ` · ${spheres.length} spheres` : ""}`
            )}
          </MapKpiPill>

          {detail?.kind === "trap" ? (
            <TrapReadingCard
              key={detail.marker.label}
              trap={detail.marker.label || ""}
              from={filters.from}
              to={filters.to}
              local={detail.marker.latest}
              details={[
                { label: "Catches in range", value: detail.marker.count },
                { label: "Placement", value: trapPlacement(traps[detail.marker.label || ""]) },
              ]}
              onClose={() => setDetail(null)}
            />
          ) : detail ? (
            <MapFloatingCard
              eyebrow={detail.kind === "hex" ? `Hexagon · ${detail.block}` : "Block"}
              title={detailTitle}
              onClose={() => setDetail(null)}
              testId="map-detail-card"
            >
              <div className="space-y-3 text-xs">
                {detail.kind === "hex" ? (
                  <div className="text-muted-foreground">
                    {hexVisits.length} visit{hexVisits.length === 1 ? "" : "s"} in the window
                    {obs ? (
                      <>
                        {" · "}
                        {obs.name}:{" "}
                        <span className="font-medium text-foreground">
                          {Math.max(0, ...hexVisits.map((e) => (e.pests_scouting_entry || []).filter((p) => p.pest === obs.name).reduce((s, p) => s + (p.count || 1), 0)))}
                        </span>{" "}
                        at most
                      </>
                    ) : null}
                  </div>
                ) : detailAgg ? (
                  <div className="text-muted-foreground">
                    {detailAgg.obs} observations · {detailAgg.trees.size} trees scouted
                    {(() => {
                      const ha = perHectare(Array.from(detailAgg.pests.values()).reduce((s, c) => s + c, 0), blockAreas[detailAgg.block]);
                      return ha != null ? ` · ${ha} pests / ha` : "";
                    })()}
                  </div>
                ) : (
                  <div className="text-muted-foreground">No scouting in this window</div>
                )}
                {detail.kind === "block" && detailAgg && (
                  <div>
                    <div className="mb-1 text-[0.7rem] uppercase tracking-wide text-muted-foreground">Top pests</div>
                    {rankedPests.length ? (
                      rankedPests.map(([name, count, band, judged]) => (
                        <div key={name} className="flex items-center gap-2 px-1.5 py-1">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ background: pestColor(name) }} aria-hidden />
                          <span className="flex-1 truncate" title={name}>{name}</span>
                          {band && judged ? <span className="tabular-nums text-[0.65rem] text-muted-foreground">{judgedLabel(judged)}</span> : null}
                          {band ? (
                            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide">{BAND_LABEL[band as "high"]}</span>
                          ) : null}
                          <span className="w-8 text-right tabular-nums text-muted-foreground">{count}</span>
                        </div>
                      ))
                    ) : (
                      <div className="px-1.5 py-1 text-muted-foreground">None</div>
                    )}
                    <div className="mb-1 mt-2 text-[0.7rem] uppercase tracking-wide text-muted-foreground">Top diseases</div>
                    {detailAgg.diseases.size ? (
                      [...detailAgg.diseases.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => (
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
                {detailBlock && plannable.has(detailBlock) && (
                  <Button size="sm" variant={picked.includes(detailBlock) ? "outline" : "default"} className="w-full rounded-full" onClick={() => togglePick(detailBlock)}>
                    {picked.includes(detailBlock) ? "Remove from the plan" : "Add to the plan"}
                  </Button>
                )}
              </div>
            </MapFloatingCard>
          ) : null}
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
              const h = blockHeat.get(b.name);
              return h ? (
                <span className="flex items-center gap-1 text-[0.65rem] tabular-nums text-muted-foreground" title={`${obs?.name ?? ""} on this block`}>
                  <span className="h-2.5 w-2.5 rounded-full border border-black/10" style={{ background: h.tone }} aria-hidden />
                  {h.label}
                </span>
              ) : null;
            }}
          />
        </aside>
      </div>
    </div>
  );
}
