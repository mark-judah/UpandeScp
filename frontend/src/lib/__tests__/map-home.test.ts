import { describe, expect, it, vi } from "vitest";

async function withPrefetch(map_settings: unknown) {
  vi.resetModules();
  (window as unknown as { SCP: unknown }).SCP = { prefetch: { map_settings } };
  return (await import("@/lib/scouting-api")).mapHomeSync;
}

describe("mapHomeSync", () => {
  it("opens on the only farm's centre, as [lng, lat]", async () => {
    const home = await withPrefetch({ lat: 0, lon: 0, default_zoom: 16, farms: { Mutara: { lat: 0.04, lon: 36.68, zoom: 15 } } });
    expect(home()).toEqual({ center: [36.68, 0.04], zoom: 15 });
  });

  it("prefers the named farm, then the site default", async () => {
    const home = await withPrefetch({
      lat: -1.0, lon: 36.0, default_zoom: 14,
      farms: { A: { lat: 1, lon: 30, zoom: 16 }, B: { lat: 2, lon: 31, zoom: 16 } },
    });
    expect(home("B")).toEqual({ center: [31, 2], zoom: 16 });
    expect(home()).toEqual({ center: [36, -1], zoom: 14 });
  });

  it("knows nothing without coordinates, so the map keeps its own default", async () => {
    const home = await withPrefetch({ lat: 0, lon: 0, default_zoom: 16, farms: {} });
    expect(home()).toBeNull();
  });
});
