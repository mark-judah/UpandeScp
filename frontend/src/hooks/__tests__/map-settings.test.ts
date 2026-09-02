/**
 * The map must not fly to Null Island.
 *
 * Map Settings is unconfigured on both kaitet and staging (`lat: 0, lon: 0`).
 * kaitet never noticed because its warehouses carry geometry, so the map fits
 * to real bounds. Staging has no geometry at all, so the fallback ran — and
 * flew to (0, 0) at zoom 16, which is open ocean in the Gulf of Guinea. That is
 * the reported "I have to zoom to my location to find the scouting entry".
 */
import { describe, expect, it, vi } from "vitest";

import { flyToFarm } from "../use-map-settings";

function fakeMap() {
  return { flyTo: vi.fn(), setView: vi.fn() };
}

const NO_SETTINGS = { lat: 0, lon: 0, default_zoom: 16, farms: {} };
const CONFIGURED = { lat: 0.5143, lon: 35.2698, default_zoom: 15, farms: {} };

describe("flyToFarm", () => {
  it("does nothing when Map Settings is unconfigured", () => {
    const m = fakeMap();
    flyToFarm(m as never, NO_SETTINGS, null);
    expect(m.flyTo).not.toHaveBeenCalled();
    expect(m.setView).not.toHaveBeenCalled();
  });

  it("leaves a data-fitted viewport alone rather than overriding it with 0,0", () => {
    // The scouting page fits bounds first, then a farm-change effect calls
    // flyToFarm. Before this guard, that second call yanked the map off the
    // data and out to sea.
    const m = fakeMap();
    flyToFarm(m as never, NO_SETTINGS, "Chepsito");
    expect(m.flyTo).not.toHaveBeenCalled();
    expect(m.setView).not.toHaveBeenCalled();
  });

  it("still flies when a real centre is configured", () => {
    const m = fakeMap();
    flyToFarm(m as never, CONFIGURED, null, { animate: false });
    expect(m.setView).toHaveBeenCalledWith([0.5143, 35.2698], 15);
  });

  it("prefers a per-farm coordinate over the global centre", () => {
    const m = fakeMap();
    const s = {
      ...CONFIGURED,
      farms: { Chepsito: { lat: 0.61, lon: 35.31, zoom: 17 } },
    };
    flyToFarm(m as never, s, "Chepsito", { animate: false });
    expect(m.setView).toHaveBeenCalledWith([0.61, 35.31], 17);
  });

  it("a per-farm coordinate of 0,0 is also treated as unset", () => {
    const m = fakeMap();
    const s = { ...CONFIGURED, farms: { Ghost: { lat: 0, lon: 0, zoom: 17 } } };
    flyToFarm(m as never, s, "Ghost");
    expect(m.flyTo).not.toHaveBeenCalled();
  });

  it("a real coordinate near the equator still works", () => {
    // Kenya sits on the equator, so lat ~0 is legitimate — only lat AND lon
    // both being ~0 means unset.
    const m = fakeMap();
    flyToFarm(m as never, { lat: 0.0002, lon: 35.27, default_zoom: 15, farms: {} }, null, {
      animate: false,
    });
    expect(m.setView).toHaveBeenCalled();
  });

  it("ignores a null map", () => {
    expect(() => flyToFarm(null, CONFIGURED, null)).not.toThrow();
  });
});
