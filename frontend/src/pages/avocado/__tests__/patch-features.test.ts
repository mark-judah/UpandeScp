import { describe, expect, it } from "vitest";
import { areaPinFeatures, draftFeatures, patchFeatures } from "../patch-features";
import type { Patch, ScoutingPin } from "@/lib/spread-api";

const coords = new Map<string, [number, number]>([["T1", [0, 0]], ["T2", [1, 0]], ["T3", [0, 1]]]);
const patch: Patch = {
  id: "P1", stations: ["T1", "T2", "T3"], size: 3, centroid: [0, 0], rows: [0, 1], cols: [0, 1],
  label: "rows 1–2, trees 1–2", change: "New", prev_size: null,
};
const base = { crop: "Avocado", warehouse: "B", shared: 1 as const, notify: 1 as const, owner: "a", may_edit: true };

describe("avocado patch features", () => {
  it("outlines a patch as a closed hull line and skips one with no placed trees", () => {
    const fc = patchFeatures(
      { week: "2031-W31", prev_week: null, unit: "row", gone: [], clusters: [patch, { ...patch, id: "P2", stations: ["T9"] }] },
      coords,
    );
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry).toEqual({ type: "LineString", coordinates: [[0, 0], [1, 0], [0, 1], [0, 0]] });
    expect(fc.features[0].properties.change).toBe("New");
  });

  it("draws area pins by their polygon and patch pins by their trees, never section pins", () => {
    const pins: ScoutingPin[] = [
      { ...base, name: "A", title: "drawn", kind: "Area", stations: ["T1"],
        polygon: { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] } },
      { ...base, name: "P", title: "frozen", kind: "Patch", stations: ["T1", "T2", "T3"], polygon: null },
      { ...base, name: "S", title: "section", kind: "Section", stations: ["T1", "T2", "T3"], polygon: null },
    ];
    const fc = areaPinFeatures(pins, coords);
    expect(fc.features.map((f) => f.properties.name)).toEqual(["A", "P"]);
    expect(fc.features[0].geometry.coordinates).toEqual([[0, 0], [2, 0], [2, 2], [0, 0]]);
  });

  it("the draft is a line from two corners and a faint polygon from three", () => {
    expect(draftFeatures([[0, 0]]).features).toHaveLength(0);
    expect(draftFeatures([[0, 0], [1, 1]]).features.map((f) => f.geometry.type)).toEqual(["LineString"]);
    expect(draftFeatures([[0, 0], [1, 0], [1, 1]]).features.map((f) => f.geometry.type)).toEqual(["LineString", "Polygon"]);
  });
});
