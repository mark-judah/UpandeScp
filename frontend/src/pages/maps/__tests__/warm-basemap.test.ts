import { describe, expect, it } from "vitest";
import { WARM_MAX_TILES, basemapTileUrls } from "../warm-basemap";

describe("basemapTileUrls", () => {
  const T = "https://t/{z}/{x}/{y}.pbf";
  const farm: [number, number, number, number] = [34.78, 1.05, 34.84, 1.08]; // ~6.7 x 3.3 km
  it("covers the farm from z12 to the source's max zoom, a handful of tiles", () => {
    const urls = basemapTileUrls(T, farm, 0, 14);
    expect(urls.some((u) => u.startsWith("https://t/12/"))).toBe(true);
    expect(urls.some((u) => u.startsWith("https://t/14/"))).toBe(true);
    expect(urls.some((u) => u.startsWith("https://t/15/"))).toBe(false);
    expect(urls.length).toBeLessThan(40);
  });
  it("stops before passing the cap", () => {
    expect(basemapTileUrls(T, farm, 0, 19).length).toBeLessThanOrEqual(WARM_MAX_TILES);
  });
});
