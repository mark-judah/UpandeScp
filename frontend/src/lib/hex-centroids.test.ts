import { describe, expect, it } from "vitest";
import { hexCentroids } from "./hex-centroids";
import type { HexSet } from "./field-geo";

describe("hexCentroids", () => {
  it("takes the mean of a closed ring without double-counting the closing corner", () => {
    const hex = {
      fc: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: 0,
            properties: { n: "H1", b: "B", r: 1 },
            geometry: { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] },
          },
        ],
      },
      idByName: new Map(),
      count: 1,
    } as unknown as HexSet;
    expect(hexCentroids(hex).get("H1")).toEqual([1, 1]);
  });
});
