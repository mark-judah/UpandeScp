import { describe, expect, it } from "vitest";
import { triadCentroids } from "./hex-centroids";
import type { TriadSet } from "./field-geo";

describe("triadCentroids", () => {
  it("is the mean of a triangle's 3 corners, not counting the closing corner twice", () => {
    const set = {
      fc: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: 0,
            properties: { name: "T1", block: "B", hexa: 1, t: 1 },
            geometry: { type: "Polygon", coordinates: [[[0, 0], [3, 0], [0, 3], [0, 0]]] },
          },
        ],
      },
      idByName: new Map(),
      count: 1,
    } as unknown as TriadSet;
    expect(triadCentroids(set).get("T1")).toEqual([1, 1]);
  });
});
