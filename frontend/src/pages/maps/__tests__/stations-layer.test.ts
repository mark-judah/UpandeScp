import { describe, expect, it } from "vitest";
import {
  DOT_STOPS,
  HIT_STOPS,
  OPEN_STOPS,
  STATION_CLICK_LAYER,
  belowStations,
  ensureStationLayers,
} from "../stations-layer";
import { dotRadius } from "../stations-leaflet";

function fakeMap() {
  const layers = new Map<string, any>();
  const order: string[] = [];
  return {
    layers,
    order,
    getSource: () => ({}),
    addSource: () => {},
    getLayer: (id: string) => layers.get(id),
    addLayer: (l: any) => {
      layers.set(l.id, l);
      order.push(l.id);
    },
  } as any;
}

describe("station dot layers", () => {
  it("draws a single small solid dot per station: no ring, no halo layer", () => {
    const map = fakeMap();
    ensureStationLayers(map);
    expect([...map.layers.keys()].sort()).toEqual(["stations-dot", "stations-hit", "stations-num", "stations-open"]);
    const dot = map.layers.get("stations-dot");
    expect(dot.type).toBe("circle");
    expect(dot.paint["circle-color"]).toEqual(["get", "color"]);
    expect(dot.paint["circle-stroke-width"]).toBeLessThan(1);
  });

  it("is a speck zoomed out and grows close in, and the open one is larger", () => {
    expect(DOT_STOPS[0][1]).toBeLessThanOrEqual(2.5);
    expect(DOT_STOPS[DOT_STOPS.length - 1][1]).toBeLessThanOrEqual(6);
    DOT_STOPS.forEach(([z, r], i) => {
      expect(OPEN_STOPS[i][0]).toBe(z);
      expect(OPEN_STOPS[i][1]).toBeGreaterThan(r);
      expect(HIT_STOPS[i][1]).toBeGreaterThanOrEqual(r);
    });
    for (let i = 1; i < DOT_STOPS.length; i++) expect(DOT_STOPS[i][1]).toBeGreaterThanOrEqual(DOT_STOPS[i - 1][1]);
  });

  it("clicks go through the invisible hit layer, numbers stay at high zoom, stations sit above", () => {
    const map = fakeMap();
    ensureStationLayers(map);
    expect(STATION_CLICK_LAYER).toBe("stations-hit");
    expect(map.layers.get("stations-hit").paint["circle-opacity"]).toBe(0);
    expect(map.layers.get("stations-num").minzoom).toBeGreaterThanOrEqual(16);
    expect(belowStations(map)).toBe("stations-hit");
  });

  it("rose map dot radius runs ~2 px to ~5 px", () => {
    expect(dotRadius(10)).toBe(2);
    expect(dotRadius(22)).toBe(5);
    expect(dotRadius(16)).toBeGreaterThan(dotRadius(13));
  });
});
