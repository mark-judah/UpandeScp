import { describe, expect, it } from "vitest";
import { projectGeometry, type ZoneGeoLike } from "../bed-projection";

const zones: ZoneGeoLike[] = [
  { name: "Z1", coords: [[35.7542, 0.0679], [35.75417, 0.06792]], lineId: 1 },
  { name: "Z2", coords: [[35.75417, 0.06792], [35.75414, 0.06794]], lineId: 1 },
  { name: "Z3", coords: [[35.7543, 0.06795], [35.75427, 0.06797]], lineId: 2 },
];

describe("projectGeometry.unproject", () => {
  it("unprojects every zone centroid back to its lng/lat", () => {
    const g = projectGeometry(zones)!;
    for (const z of zones) {
      const c = g.zoneCentroids[z.name];
      const [lng, lat] = g.unproject!(c.cx, c.cy);
      expect(lng).toBeCloseTo((z.coords![0][0] + z.coords![1][0]) / 2, 9);
      expect(lat).toBeCloseTo((z.coords![0][1] + z.coords![1][1]) / 2, 9);
    }
  });
});
