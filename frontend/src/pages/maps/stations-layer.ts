/**
 * The "Stations" layers on a MapLibre map: one small solid dot per recorded station, in the
 * scout's colour (no ring, no halo - a thin white edge only so it reads on dark ground), a visit
 * number when zoomed in, and a larger dark-edged dot on the open one. GeoJSON circle/symbol
 * layers, so tens of thousands of trees cost nothing extra. Circles keep a pixel size
 * (viewport-aligned), and an invisible, larger hit layer keeps a 2 px dot easy to click. The
 * layers are kept on top of the trees, zones and tracks.
 */
import type maplibregl from "maplibre-gl";
import type { StationFC } from "@/lib/scouting-stations";

export const STATIONS_SOURCE = "stations";
const HIT = "stations-hit";
const DOT = "stations-dot";
const NUM = "stations-num";
const OPEN = "stations-open";
export const STATION_CLICK_LAYER = HIT;
const LAYERS = [HIT, DOT, OPEN, NUM];

/** Pixel radius by zoom: a speck zoomed out (so thousands do not pile into a mass), bigger close in. */
export const DOT_STOPS: Array<[number, number]> = [[12, 2], [15, 3], [18, 4.5], [21, 5.5]];
/** The open station: a little larger than its neighbours at every zoom. */
export const OPEN_STOPS: Array<[number, number]> = [[12, 4], [15, 5.5], [18, 7.5], [21, 9]];
/** Click target: never smaller than a fingertip-friendly dot. */
export const HIT_STOPS: Array<[number, number]> = [[12, 6], [15, 7], [18, 8], [21, 9]];

const interp = (stops: Array<[number, number]>) =>
  ["interpolate", ["linear"], ["zoom"], ...stops.flat()] as never;

const EMPTY: StationFC = { type: "FeatureCollection", features: [] };

/** Add the source + layers once; returns true when they exist afterwards. */
export function ensureStationLayers(map: maplibregl.Map): boolean {
  if (!map.getSource(STATIONS_SOURCE)) {
    map.addSource(STATIONS_SOURCE, { type: "geojson", data: EMPTY as never });
  }
  if (!map.getLayer(HIT)) {
    map.addLayer({
      id: HIT,
      type: "circle",
      source: STATIONS_SOURCE,
      paint: {
        "circle-radius": interp(HIT_STOPS),
        "circle-color": "#000000",
        "circle-opacity": 0,
        "circle-pitch-alignment": "viewport",
      },
    });
  }
  if (!map.getLayer(DOT)) {
    map.addLayer({
      id: DOT,
      type: "circle",
      source: STATIONS_SOURCE,
      paint: {
        "circle-radius": interp(DOT_STOPS),
        "circle-color": ["get", "color"] as never,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 0.75,
        "circle-pitch-alignment": "viewport",
      },
    });
  }
  if (!map.getLayer(OPEN)) {
    map.addLayer({
      id: OPEN,
      type: "circle",
      source: STATIONS_SOURCE,
      filter: ["==", ["get", "sid"], ""] as never,
      paint: {
        "circle-radius": interp(OPEN_STOPS),
        "circle-color": ["get", "color"] as never,
        "circle-stroke-color": "#0a0a0a",
        "circle-stroke-width": 2,
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
        "text-offset": [0, -1.2],
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
  return map.getLayer(HIT) ? HIT : undefined;
}
