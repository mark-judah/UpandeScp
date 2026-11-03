/**
 * The "Stations" layers on a MapLibre map: one ring + dot per recorded station,
 * in the scout's colour, a visit number when zoomed in, and a dark halo on the
 * open one. GeoJSON circle/symbol layers, so tens of thousands of trees cost
 * nothing extra. Circles keep a pixel size (viewport-aligned), so they stay
 * readable at pitch 0 or tilted, and the layers are kept on top of the trees,
 * zones and tracks.
 */
import type maplibregl from "maplibre-gl";
import type { StationFC } from "@/lib/scouting-stations";

export const STATIONS_SOURCE = "stations";
const RING = "stations-ring";
const DOT = "stations-dot";
const NUM = "stations-num";
const OPEN = "stations-open";
export const STATION_CLICK_LAYER = RING;
const LAYERS = [OPEN, RING, DOT, NUM];

/** Pixel radius by zoom: a clear ring when the orchard is a speck, bigger close in. */
const RADIUS = ["interpolate", ["linear"], ["zoom"], 12, 3.5, 15, 5.5, 18, 8.5, 21, 11] as never;
const DOT_RADIUS = ["interpolate", ["linear"], ["zoom"], 12, 1.6, 15, 2.6, 18, 4, 21, 5.2] as never;
const OPEN_RADIUS = ["interpolate", ["linear"], ["zoom"], 12, 7, 15, 9.5, 18, 13, 21, 16] as never;

const EMPTY: StationFC = { type: "FeatureCollection", features: [] };

/** Add the source + layers once; returns true when they exist afterwards. */
export function ensureStationLayers(map: maplibregl.Map): boolean {
  if (!map.getSource(STATIONS_SOURCE)) {
    map.addSource(STATIONS_SOURCE, { type: "geojson", data: EMPTY as never });
  }
  if (!map.getLayer(OPEN)) {
    map.addLayer({
      id: OPEN,
      type: "circle",
      source: STATIONS_SOURCE,
      filter: ["==", ["get", "sid"], ""] as never,
      paint: {
        "circle-radius": OPEN_RADIUS,
        "circle-color": "#0a0a0a",
        "circle-opacity": 0.18,
        "circle-stroke-color": "#0a0a0a",
        "circle-stroke-width": 2,
      },
    });
  }
  if (!map.getLayer(RING)) {
    map.addLayer({
      id: RING,
      type: "circle",
      source: STATIONS_SOURCE,
      paint: {
        "circle-radius": RADIUS,
        "circle-color": "#ffffff",
        "circle-stroke-color": ["get", "color"] as never,
        "circle-stroke-width": 2.5,
        "circle-pitch-alignment": "viewport",
        "circle-pitch-scale": "viewport",
      },
    });
  }
  if (!map.getLayer(DOT)) {
    map.addLayer({
      id: DOT,
      type: "circle",
      source: STATIONS_SOURCE,
      paint: {
        "circle-radius": DOT_RADIUS,
        "circle-color": ["get", "color"] as never,
        "circle-pitch-alignment": "viewport",
      },
    });
  }
  if (!map.getLayer(NUM)) {
    map.addLayer({
      id: NUM,
      type: "symbol",
      source: STATIONS_SOURCE,
      minzoom: 16.5,
      filter: ["!=", ["get", "num"], ""] as never,
      layout: {
        "text-field": ["get", "num"] as never,
        "text-font": ["Noto Sans Bold"],
        "text-size": 11,
        "text-offset": [0, -1.5],
        "text-allow-overlap": false,
        "text-padding": 1,
      },
      paint: {
        "text-color": "#0a0a0a",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1.6,
      },
    });
  }
  return true;
}

export function setStationData(map: maplibregl.Map, fc: StationFC): void {
  const src = map.getSource(STATIONS_SOURCE) as maplibregl.GeoJSONSource | undefined;
  src?.setData(fc as never);
}

export function setStationOpen(map: maplibregl.Map, sid: string | null): void {
  if (map.getLayer(OPEN)) map.setFilter(OPEN, ["==", ["get", "sid"], sid ?? ""] as never);
}

export function setStationsVisible(map: maplibregl.Map, on: boolean): void {
  for (const id of LAYERS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  }
}

/** Keep the station layers above everything added since (trees, tracks, zones). */
export function raiseStations(map: maplibregl.Map): void {
  for (const id of LAYERS) if (map.getLayer(id)) map.moveLayer(id);
}

/** Layer id other layers should be inserted below, so stations stay on top. */
export function belowStations(map: maplibregl.Map): string | undefined {
  return map.getLayer(OPEN) ? OPEN : undefined;
}
