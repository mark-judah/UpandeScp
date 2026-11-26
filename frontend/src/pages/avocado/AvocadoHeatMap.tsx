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
import { Layers } from "lucide-react";
import { useCropFarms } from "@/hooks/use-crop-farms";
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
import { BlockFilterPill } from "@/components/spray-plan/BlockFilterPill";
import { fetchRoundPerHa, type RoundPerHa } from "@/lib/cumulative-api";
import { blockWeekly } from "@/lib/weekly-threshold";
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
import { observationOptions, type ObsOption } from "@/lib/pest-heat";
import { rgbOf, toneBands, toneOf } from "@/lib/pest-tone";
import { trapPlacement, trapUnitLayers } from "@/lib/trap-units";
import { TRAP_FOCUS_ZOOM } from "@/lib/trap-pulse";
import { entryPoint, unitKey } from "@/lib/unit-key";
import type { ScoutingEntry } from "@/lib/scouting-types";
import { triadObsColors } from "@/lib/triad-colors";
import { ObservationMultiPicker, obsOptionKey as obsKey } from "@/components/ObservationMultiPicker";
import { multiUnitColors } from "@/lib/triad-multi";
import { blockColors } from "../maps/field-layers";
import { triangleClickable, useFieldIndex, useFieldLattice } from "../maps/use-field-lattice";
import { addTrapMarkers, drawTrapUnits, flyToTrap } from "../maps/trap-layers";
import { SpheresLayer } from "../maps/SpheresLayer";
import { spherePoints } from "../maps/sphere-data";
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
  const [blockAreas, setBlockAreas] = useState<Record<string, number>>({});
  // Blocks picked for spraying — the same list the planning column ticks.
  const [picked, setPicked] = useState<string[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const [plannable, setPlannable] = useState<Set<string>>(new Set());
  const [groups, setGroups] = useState<OpenFieldGroup[]>([]);
  // This ISO week's cumulative per-ha figures and thresholds: the numbers the alerts use.
  const [round, setRound] = useState<RoundPerHa | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  // The pests and diseases the map shows (null = all of them, so ones seen later join in).
  const [pickedObs, setPickedObs] = useState<Set<string> | null>(null);
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
  useEffect(() => {
    let alive = true;
    setRound(null);
    fetchRoundPerHa(filters.crop, { farm: filters.farm === ALL ? undefined : filters.farm })
      .then((r) => alive && setRound(r))
      .catch(() => alive && setRound(null));
    return () => {
      alive = false;
    };
  }, [filters.crop, filters.farm]);
  // The 2D/3D switch means trees: it shows only when the farm has tree-level elements mapped.
  const hasTrees = (treePoints?.names.length ?? 0) > 0;
  // Hexas and triangles: an index first (per block, how many), then the whole farm's lattice in
  // the background (useFieldLattice below), drawn instanced once zoomed in.
  const farmKey = filters.farm === ALL ? "" : filters.farm;
  // A single-farm crop is switched to its farm by MapHeader once the farm list is in: until then
  // the farm is not settled and the per-farm geometry waits (no "All farms" fetch first).
  const cropFarms = useCropFarms(filters.crop);
  const farmSettled = filters.farm !== ALL || (!cropFarms.loading && Object.keys(cropFarms.farms).length !== 1);
  const { index: fieldIndex, refresh: refreshFieldIndex } = useFieldIndex(farmKey, farmSettled);
  const hexBlocks = useMemo(
    () => new Set(Object.entries(fieldIndex?.counts ?? {}).filter(([, c]) => c[0] > 0).map(([b]) => b)),
    [fieldIndex],
  );

  useEffect(() => {
    let cancelled = false;
    void fetchTrapLocations(filters.farm === ALL ? undefined : filters.farm).then((t) => {
      if (!cancelled) setTraps(t);
    });
    return () => {
      cancelled = true;
    };
  }, [filters.farm]);

  // The observations seen in the window; the map shows the selected ones.
  const obsOptions = useMemo(() => (data ? observationOptions(data.entries) : []), [data]);
  const selected = useMemo(
    () => (pickedObs ? obsOptions.filter((o) => pickedObs.has(obsKey(o))) : obsOptions),
    [obsOptions, pickedObs],
  );
  const selectedKeys = useMemo(() => new Set(selected.map(obsKey)), [selected]);
  // Exactly one selected keeps the single-observation behaviour; several take, per patch, the
  // colour of the worst selected observation there.
  const obs: ObsOption | null = selected.length === 1 ? selected[0] : null;
  const multi = selected.length > 1;
  const obsLabel = obs ? obs.name : multi ? `${selected.length} pests and diseases` : "";
  const onPick = (next: Set<string>) =>
    setPickedObs(obsOptions.length > 0 && obsOptions.every((o) => next.has(obsKey(o))) ? null : next);
  const colorOfObs = (o: { kind: string; name: string }) => hexOf(o.kind === "pest" ? pestColor(o.name) : diseaseColor(o.name));
  // The observation's own colour; its tones (low, medium, high, clean) paint every unit. With
  // several selected there is no single colour: the neutral stands in for the clean wash.
  const obsColor = obs ? colorOfObs(obs) : NO_OBS;
  const tones = useMemo(() => toneBands(obsColor), [obsColor]);

  // A block with a configured weekly threshold is coloured by the alerts' own figure (this
  // ISO week's cumulative count per hectare against the threshold), so colour and alert agree.
  const weekly = useMemo(() => blockWeekly(round, selected), [round, selected]);
  const weeklyTones = useMemo(() => {
    const m = new Map<string, string>();
    for (const [block, w] of weekly) {
      const base = multi ? colorOfObs({ kind: w.kind, name: w.observation }) : obsColor;
      m.set(block, toneOf(base, w.cls));
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekly, multi, obsColor, pestColor, diseaseColor]);

  // Every finding is tied to its triad (the Scouting Entry's own, else the nearest one by the
  // lattice maths once the farm's lattice is in) and the triad is filled solid in its pest's
  // colour, in three strength steps; no triad without a finding is filled.
  const hasObs = (e: ScoutingEntry, o: ObsOption) =>
    o.kind === "pest"
      ? (e.pests_scouting_entry || []).some((p) => p.pest === o.name)
      : (e.diseases_scouting_entry || []).some((d) => d.disease === o.name);
  const hitEntries = useMemo(
    () => (data ? data.entries.filter((e) => e.block && selected.some((o) => hasObs(e, o))) : []),
    [data, selected],
  );
  const [nearest, setNearest] = useState<Map<string, string>>(new Map());
  const solidEntries = useMemo(
    () => hitEntries.map((e) => (!e.triad && !e.tree && nearest.has(e.name) ? { ...e, triad: nearest.get(e.name) } : e)),
    [hitEntries, nearest],
  );
  const unitTones = useMemo(
    () =>
      multi
        ? multiUnitColors(solidEntries, selected, colorOfObs, unitKey, NO_OBS)
        : triadObsColors(solidEntries, obs, tones, unitKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [solidEntries, obs, tones, multi, selected, pestColor, diseaseColor],
  );
  const solidBlockTones = useMemo(() => {
    const m = blockColors(solidEntries, unitTones);
    for (const [b, tone] of weeklyTones) m.set(b, tone);
    return m;
  }, [solidEntries, unitTones, weeklyTones]);
  const fieldLattice = useFieldLattice({
    mapRef,
    mapReady,
    blocks,
    farmKey,
    index: fieldIndex,
    onStale: refreshFieldIndex,
    colors: unitTones,
    perBlock: solidBlockTones,
    pointEntries: solidEntries,
    showTri: showHex,
    showHexa: showHex,
    unscoutedFill: false,
  });
  useEffect(() => {
    if (!fieldLattice.ready) return;
    const m = new Map<string, string>();
    for (const e of hitEntries) {
      if (e.triad || e.tree) continue;
      const pt = entryPoint(e);
      const t = pt && fieldLattice.pick(pt[0], pt[1], e.block);
      if (t) m.set(e.name, t);
    }
    setNearest(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldLattice.ready, hitEntries]);

  // Why the map is blank, said plainly.
  const emptyMsg =
    !data || loading || loadingGeo || !blocks
      ? null
      : blocks.features.length === 0
        ? "No blocks mapped for this crop yet"
        : !selected.length
          ? "Pick at least one pest or disease"
          : !obsOptions.length
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

  // Each block's heat for the list: the solid wash, or the weekly threshold's own figure.
  const blockHeat = useMemo(() => {
    const m = new Map<string, { tone: string; label: string; name?: string }>();
    for (const [b, tone] of solidBlockTones) m.set(b, { tone, label: "" });
    for (const [b, w] of weekly) m.set(b, { tone: weeklyTones.get(b) || "", label: `${fmt(w.perHa)}/ha`, name: multi ? w.observation : undefined });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solidBlockTones, weekly, weeklyTones, multi]);

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
  const showHexRef = useRef(showHex);
  showHexRef.current = showHex;
  const clickRef = useRef<(e: maplibregl.MapMouseEvent) => void>(() => {});
  clickRef.current = (e) => {
    const map = mapRef.current;
    if (!map) return;
    // Close enough to see triangles: a click names the one under it (the lattice maths the grid
    // was cut with), not the block.
    if (triangleClickable(map.getZoom(), fieldLattice.triZoom, showHexRef.current)) {
      const name = fieldLattice.pick(e.lngLat.lng, e.lngLat.lat);
      if (name) {
        setDetail({ kind: "hex", unit: name, block: name.replace(/ - Hexa \d+ - Triad \d+$/, "") });
        return;
      }
    }
    const layers = ["blocks-fill"].filter((id) => map.getLayer(id));
    const hits = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : [];
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

  // The weekly-threshold wash on blocks that have no triangles (blocks with triangles take it
  // through their own wash, see solidBlockTones). Feature-state "w", the pest's colour at the
  // level's intensity.
  const weeklyPaintedRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !blocks || !map.getSource("blocks")) return;
    const plain = ["!", ["in", ["get", "block"], ["literal", [...hexBlocks]]]] as never;
    if (!map.getLayer("blocks-weekly")) {
      map.addLayer(
        {
          id: "blocks-weekly",
          type: "fill",
          source: "blocks",
          filter: plain,
          paint: { "fill-color": ["coalesce", ["feature-state", "w"], "rgba(0,0,0,0)"] as never, "fill-opacity": 0.4 },
        },
        map.getLayer("blocks-line") ? "blocks-line" : undefined,
      );
    } else map.setFilter?.("blocks-weekly", plain);
    const prev = weeklyPaintedRef.current;
    for (const b of prev.keys()) if (!weeklyTones.has(b)) map.removeFeatureState({ source: "blocks", id: b }, "w");
    for (const [b, w] of weeklyTones) if (prev.get(b) !== w) map.setFeatureState({ source: "blocks", id: b }, { w });
    weeklyPaintedRef.current = new Map(weeklyTones);
  }, [weeklyTones, hexBlocks, blocks, mapReady]);

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
    if (!view3d || !hasTrees || !data) return [];
    const centres = new Map<string, [number, number]>();
    const centreOf = (k: string): [number, number] | null => {
      const hit = centres.get(k);
      if (hit) return hit;
      const c = fieldLattice.centroid(k);
      if (c) centres.set(k, c);
      return c;
    };
    if (!multi) return spherePoints(data.entries, obs, centreOf);
    // Several selected: one sphere per unit, sized by the worst of them (drawn in the neutral tone).
    const by = new Map<string, ReturnType<typeof spherePoints>[number]>();
    for (const o of selected)
      for (const p of spherePoints(data.entries, o, centreOf)) {
        const prev = by.get(p.key);
        if (!prev || p.value > prev.value) by.set(p.key, p);
      }
    return [...by.values()];
  }, [view3d, hasTrees, data, obs, multi, selected, fieldLattice.ready]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (!view3d || !hasTrees) {
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
  }, [view3d, hasTrees, spheres, obsColor, mapReady]);

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
  // The worst selected observation seen at the open hexagon (its biggest single visit).
  const hexWorst = useMemo(() => {
    let best: { name: string; value: number } | null = null;
    for (const o of selected) {
      const value = Math.max(
        0,
        ...hexVisits.map((e) =>
          o.kind === "pest"
            ? (e.pests_scouting_entry || []).filter((p) => p.pest === o.name).reduce((s, p) => s + (p.count || 1), 0)
            : (e.diseases_scouting_entry || []).filter((d) => d.disease === o.name).length,
        ),
      );
      if (!best || value > best.value) best = { name: o.name, value };
    }
    return best;
  }, [selected, hexVisits]);

  const first = firstLoad(loading || (!data && !error), !!data);
  const detailTitle = detail?.kind === "block" ? detail.block : detail?.kind === "hex" ? detail.unit.split(" - ").slice(-2).join(" · ") : "";

  return (
    <div className="flex h-svh flex-col overflow-y-auto lg:overflow-hidden">
      <MapHeader
        title="Application Floor Plan"
        subtitle={obsLabel ? `${obsLabel} · select blocks on the map or in the list, plan each` : "Pest & disease, then the plan"}
        value={filters}
        onChange={setFilters}
        showGreenhouse={false}
        hideSingleFarm
        beforeDate={
          <>
            <BlockFilterPill
              groups={groups}
              selected={picked}
              onChange={onListSelect}
              focus={focus}
              loading={!groups.length && plannable.size === 0 && !blocks}
              rowExtra={(b) => {
                const h = blockHeat.get(b.name);
                return h ? (
                  <span className="flex items-center gap-1 text-[0.65rem] tabular-nums text-muted-foreground">
                    <span className="h-2.5 w-2.5 rounded-full border border-black/10" style={{ background: h.tone }} aria-hidden />
                    {h.name && <span className="max-w-[5rem] truncate">{h.name}</span>}
                    {h.label}
                  </span>
                ) : null;
              }}
            />
            <ObservationMultiPicker options={obsOptions} value={selectedKeys} onChange={onPick} />
          </>
        }
        rightSlot={
          hasTrees ? (
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
          ) : null
        }
      />
      <LoadProgress active={loading || loadingGeo} progress={loading ? progress : 100} />
      {error && !data && !loading && (
        <span role="alert" className="px-4 text-xs text-destructive md:px-6">{error}</span>
      )}

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
            ) : (
              `${unitTones.size} triangles with ${obsLabel || "findings"}${view3d ? ` · ${spheres.length} spheres` : ""}`
            )}
          </MapKpiPill>

          {/* Layers: one icon button in the map's top-right control stack (under the zoom control). */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Layers"
                title="Layers"
                data-testid="map-layers-button"
                className="absolute right-[10px] top-[112px] z-[1000] flex h-[29px] w-[29px] items-center justify-center rounded bg-white text-neutral-800 shadow-[0_0_0_2px_rgba(0,0,0,0.1)] hover:bg-neutral-100"
              >
                <Layers className="h-4 w-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent side="left" align="start" className="w-44 p-2">
              {(
                [
                  ["Trees", showTrees, setShowTrees],
                  ["Boundary", showBoundary, setShowBoundary],
                  ["Triangles & Hexas", showHex, setShowHex],
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

          {/* The key: a small floating card at the bottom-left of the map. */}
          <div
            className="pointer-events-none absolute bottom-10 left-3 z-[1000] flex max-w-[min(18rem,calc(100%-1.5rem))] flex-col gap-1 rounded-2xl border bg-card/95 px-3 py-2 text-[0.7rem] text-muted-foreground shadow-[var(--sd-shadow-1)] backdrop-blur"
            data-testid="heat-legend"
            title="Each triangle is filled in the colour of the pest or disease found there; stronger fill = more found"
          >
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-3 rounded-[2px] border border-dashed border-foreground/40" />
              No observations
            </span>
            {selected.slice(0, 5).map((o) => (
              <span key={obsKey(o)} className="flex items-center gap-1.5" data-testid="legend-obs">
                <span className="h-2.5 w-2.5 rounded-full border border-black/10" style={{ background: colorOfObs(o) }} /> {o.name}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              {(["Low", "Medium", "High"] as const).map((label, i) => (
                <span key={label} className="flex items-center gap-1" data-tone={label}>
                  <span className="h-2.5 w-3 rounded-[2px] border border-black/10" style={{ background: tones[i] }} />
                  {label}
                </span>
              ))}
            </span>
          </div>

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
              eyebrow={detail.kind === "hex" ? `Triangle · ${detail.block}` : "Block"}
              title={detailTitle}
              onClose={() => setDetail(null)}
              testId="map-detail-card"
            >
              <div className="space-y-3 text-xs">
                {detail.kind === "hex" ? (
                  <div className="text-muted-foreground">
                    {hexVisits.length} visit{hexVisits.length === 1 ? "" : "s"} in the window
                    {hexWorst ? (
                      <>
                        {" · "}
                        {hexWorst.name}:{" "}
                        <span className="font-medium text-foreground">{hexWorst.value}</span>{" "}
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
            hideBlockPicker
            onFocusBlock={(b) => { setFocus(b); flyToBlock(b); }}
            onBlocks={(gs: OpenFieldGroup[]) => {
              setGroups(gs);
              setPlannable(new Set(gs.flatMap((g) => g.blocks.map((b) => b.name))));
            }}
            rowExtra={(b) => {
              const h = blockHeat.get(b.name);
              return h ? (
                <span className="flex items-center gap-1 text-[0.65rem] tabular-nums text-muted-foreground" title={`${h.name ? `${h.name} is the worst of ${obsLabel}` : obs?.name ?? ""} on this block`}>
                  <span className="h-2.5 w-2.5 rounded-full border border-black/10" style={{ background: h.tone }} aria-hidden />
                  {h.name && <span className="max-w-[5rem] truncate">{h.name}</span>}
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
