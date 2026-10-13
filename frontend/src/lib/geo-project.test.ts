import { describe, expect, it } from "vitest";
import { projectFromUnproject } from "@/lib/geo-project";
import { projectGeometry } from "@/pages/maps/bed-projection";

describe("projectFromUnproject", () => {
  it("inverts the geometry's unproject, zone centroids included", () => {
    const zones = [1, 2, 3].flatMap((b) =>
      [1, 2].map((z) => ({ name: `G - Bed ${b} - Zone ${z}`, coords: [[36 + z * 1e-4, -1 + b * 1e-4], [36 + z * 1e-4 + 1e-4, -1 + b * 1e-4 + 2e-5]] as [[number, number], [number, number]], lineId: b })),
    );
    const g = projectGeometry(zones)!;
    const project = projectFromUnproject(g.unproject!)!;
    for (const c of Object.values(g.zoneCentroids)) {
      const [lng, lat] = g.unproject!(c.cx, c.cy);
      const [x, y] = project(lng, lat);
      expect(x).toBeCloseTo(c.cx, 3);
      expect(y).toBeCloseTo(c.cy, 3);
    }
  });
  it("returns null for a degenerate mapping", () => {
    expect(projectFromUnproject(() => [1, 1])).toBeNull();
  });
});
