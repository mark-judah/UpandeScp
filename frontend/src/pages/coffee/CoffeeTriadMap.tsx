/**
 * Coffee · Triads (test harness) — top-down tessellation of the Endebess AOI.
 *
 * The whole AOI is tessellated ONCE per (side, rotation) and handed to MapLibre
 * as a static layer — no per-move regeneration ("live mask"), so panning and
 * zooming are pure GPU and stay smooth. Generation stays fast via the coarse-cell
 * classification in lib/triad.ts (interior cells emit with no per-triad
 * point-in-polygon; only boundary cells test).
 *
 * "Block ×k" overlays a coarser triad grid at side k·s. Because both grids share
 * the same origin (a lattice point at the AOI centre) the triangular tiling is
 * self-similar, so each bigger triangle sits exactly on k² unit triads — the
 * prediction ratio is 1 : k².
 *
 * ⚠️ Exploratory — boundary units kept whole (not clipped).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { Map3D } from "@/components/Map3D";
import { Input } from "@/components/ui/input";
import { buildTriadIndex, tessellate, deriveRows } from "@/lib/triad";
import { ENDEBESS_AOI, ENDEBESS_CENTER } from "./endebess-aoi";

// One flat colour for every unit — no palette.
const UNIT_COLOR = "#5BB45D";

export function CoffeeTriadMap() {
  const [side, setSide] = useState(10);
  const [rotation, setRotation] = useState(0);
  const [blockFactor, setBlockFactor] = useState(2); // 1 = off
  const [showRows, setShowRows] = useState(true);
  const [triadCount, setTriadCount] = useState(0);
  const [blockCount, setBlockCount] = useState(0);
  const [rowStats, setRowStats] = useState({ rows: 0, endpoints: 0 });

  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);

  // Fine triads for the current side/rotation.
  const index = useMemo(
    () => buildTriadIndex(ENDEBESS_AOI, side, rotation),
    [side, rotation],
  );
  // Bigger triangles: same origin/rotation, side scaled by the block factor.
  const blockIndex = useMemo(
    () => (blockFactor > 1 ? buildTriadIndex(ENDEBESS_AOI, side * blockFactor, rotation) : null),
    [side, rotation, blockFactor],
  );
  const indexRef = useRef(index);
  indexRef.current = index;
  const blockIndexRef = useRef(blockIndex);
  blockIndexRef.current = blockIndex;

  // Tessellate the WHOLE AOI once and push both layers to their static sources.
  const generate = () => {
    const map = mapRef.current;
    if (!map) return;
    const fine = tessellate(indexRef.current, { maxFeatures: Infinity });
    const fineSrc = map.getSource("triads") as maplibregl.GeoJSONSource | undefined;
    if (fineSrc) fineSrc.setData(fine.fc as never);
    setTriadCount(fine.triadCount);

    const blocks = tessellate(blockIndexRef.current, { maxFeatures: Infinity });
    const blockSrc = map.getSource("blocks") as maplibregl.GeoJSONSource | undefined;
    if (blockSrc) blockSrc.setData(blocks.fc as never);
    setBlockCount(blocks.triadCount);

    // Row "constellation": one line per run (first→last hex centre) + endpoints.
    const runs = deriveRows(indexRef.current);
    const rowLines = {
      type: "FeatureCollection",
      features: runs.map((r) => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [r.first, r.last] },
        properties: { count: r.hexCount },
      })),
    };
    const endpoints = {
      type: "FeatureCollection",
      features: runs.flatMap((r) => [
        { type: "Feature", geometry: { type: "Point", coordinates: r.first }, properties: { end: "first" } },
        { type: "Feature", geometry: { type: "Point", coordinates: r.last }, properties: { end: "last" } },
      ]),
    };
    (map.getSource("rows") as maplibregl.GeoJSONSource | undefined)?.setData(rowLines as never);
    (map.getSource("row-ends") as maplibregl.GeoJSONSource | undefined)?.setData(endpoints as never);
    setRowStats({ rows: runs.length, endpoints: runs.length * 2 });
  };

  const onMapReady = (map: maplibregl.Map) => {
    mapRef.current = map;
    map.on("load", () => setMapReady(true));
  };

  // Sources/layers + initial fit, once the map has loaded.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (!map.getSource("aoi")) {
      map.addSource("aoi", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Polygon", coordinates: [[...ENDEBESS_AOI, ENDEBESS_AOI[0]]] },
              properties: {},
            },
          ],
        } as never,
      });
      map.addLayer({
        id: "aoi-line",
        type: "line",
        source: "aoi",
        paint: { "line-color": "#0a0a0a", "line-width": 2, "line-dasharray": [2, 1], "line-opacity": 0.6 },
      });
    }
    if (!map.getSource("triads")) {
      map.addSource("triads", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] } as never,
      });
      map.addLayer(
        {
          id: "triads-fill",
          type: "fill",
          source: "triads",
          paint: { "fill-color": UNIT_COLOR, "fill-opacity": 0.45 },
        },
        "aoi-line",
      );
      map.addLayer(
        {
          id: "triads-line",
          type: "line",
          source: "triads",
          paint: { "line-color": "#ffffff", "line-width": 0.4, "line-opacity": 0.5 },
        },
        "aoi-line",
      );
    }
    // Bigger-triangle edges, drawn bold on top of the fine grid.
    if (!map.getSource("blocks")) {
      map.addSource("blocks", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] } as never,
      });
      map.addLayer(
        {
          id: "blocks-line",
          type: "line",
          source: "blocks",
          paint: { "line-color": "#0a0a0a", "line-width": 1.6, "line-opacity": 0.85 },
        },
        "aoi-line",
      );
    }
    // Row constellation: endpoint→endpoint lines + first/last hex markers.
    if (!map.getSource("rows")) {
      map.addSource("rows", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] } as never,
      });
      map.addLayer({
        id: "rows-line",
        type: "line",
        source: "rows",
        paint: { "line-color": "#1d4ed8", "line-width": 1, "line-opacity": 0.5 },
      });
    }
    if (!map.getSource("row-ends")) {
      map.addSource("row-ends", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] } as never,
      });
      map.addLayer({
        id: "row-ends-dot",
        type: "circle",
        source: "row-ends",
        paint: {
          "circle-radius": 3,
          "circle-color": ["match", ["get", "end"], "first", "#16a34a", "#dc2626"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
        },
      });
    }
    const lons = ENDEBESS_AOI.map((p) => p[0]);
    const lats = ENDEBESS_AOI.map((p) => p[1]);
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: 40, duration: 500 },
    );
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady]);

  // Re-tessellate only when the lattices change — never on pan/zoom.
  useEffect(() => {
    if (mapReady) generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, blockIndex, mapReady]);

  // Toggle the row constellation on/off.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const vis = showRows ? "visible" : "none";
    for (const id of ["rows-line", "row-ends-dot"]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
    }
  }, [showRows, mapReady]);

  const ratio = blockFactor > 1 ? blockFactor * blockFactor : 6;
  const ratioLabel = blockFactor > 1 ? `1 : ${ratio} (bigger triangle)` : "1 : 6 (hexagon)";
  const compression =
    rowStats.endpoints > 0 ? Math.round(triadCount / rowStats.endpoints) : 0;

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b px-4 py-3 md:px-6">
        <div>
          <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">
            Coffee · tessellation test · Endebess Part A
          </div>
          <h1 className="text-lg font-semibold leading-tight">Triads</h1>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Side (m)
            <Input
              type="number"
              min={2}
              step={1}
              value={side}
              onChange={(e) => setSide(Math.max(2, Number(e.target.value) || 2))}
              className="h-9 w-20"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Block ×
            <Input
              type="number"
              min={1}
              max={8}
              step={1}
              value={blockFactor}
              onChange={(e) => setBlockFactor(Math.min(8, Math.max(1, Number(e.target.value) || 1)))}
              className="h-9 w-16"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Rotation ({rotation}°)
            <input
              type="range"
              min={-90}
              max={90}
              value={rotation}
              onChange={(e) => setRotation(Number(e.target.value))}
              className="h-9 w-40"
            />
          </label>
          <label className="flex items-center gap-1.5 pb-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showRows}
              onChange={(e) => setShowRows(e.target.checked)}
            />
            Rows
          </label>
          <span className="pb-2 text-xs tabular-nums text-muted-foreground">
            {triadCount.toLocaleString()} triads
            {blockFactor > 1 && ` · ${blockCount.toLocaleString()} blocks`} · ratio {ratioLabel}
            {showRows && rowStats.rows > 0 && (
              <>
                {" · "}
                {rowStats.rows.toLocaleString()} rows → {rowStats.endpoints.toLocaleString()} endpoints
                {compression > 0 && ` predict ${triadCount.toLocaleString()} triads (1:${compression})`}
              </>
            )}
          </span>
        </div>
      </header>

      <div className="flex-1 min-h-0 px-4 pb-4 md:px-6 md:pb-6">
        <div className="h-full w-full overflow-hidden rounded-[20px] border border-border shadow-[var(--sd-shadow-1)]">
          <Map3D onReady={onMapReady} initialPitch={0} initialCenter={ENDEBESS_CENTER} initialZoom={14} />
        </div>
      </div>
    </div>
  );
}
