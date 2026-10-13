import { describe, expect, it } from "vitest";
import { areaShares, groupAdjacentBlocks, largestBlock } from "@/lib/block-groups";

// 0.00001 deg is ~1.11 m (at the equator, so lng and lat scale alike).
const D = 0.00001;
const sq = (name: string, x: number, y: number, w = 100 * D, h = 100 * D) => ({
  properties: { block: name },
  geometry: {
    type: "Polygon",
    coordinates: [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]],
  },
});

describe("groupAdjacentBlocks", () => {
  it("joins blocks that touch", () => {
    const f = [sq("A", 0, 0), sq("B", 100 * D, 0)];
    expect(groupAdjacentBlocks(f, ["A", "B"], 15)).toEqual([["A", "B"]]);
  });
  it("joins a ~10 m gap but not a ~20 m gap", () => {
    const f = [sq("A", 0, 0), sq("B", 109 * D, 0), sq("C", 0, 118 * D)];
    expect(groupAdjacentBlocks(f, ["A", "B"], 15)).toEqual([["A", "B"]]);
    expect(groupAdjacentBlocks(f, ["A", "C"], 15)).toEqual([["A"], ["C"]]);
  });
  it("chains A-B-C when only neighbours are close", () => {
    const f = [sq("A", 0, 0), sq("B", 110 * D, 0), sq("C", 220 * D, 0)];
    expect(groupAdjacentBlocks(f, ["A", "B", "C"], 15)).toEqual([["A", "B", "C"]]);
    expect(groupAdjacentBlocks(f, ["A", "C"], 15)).toEqual([["A"], ["C"]]);
  });
  it("is MultiPolygon aware", () => {
    const m = {
      properties: { block: "M" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          sq("x", 1000 * D, 1000 * D).geometry.coordinates,
          sq("y", 105 * D, 0).geometry.coordinates,
        ],
      },
    };
    expect(groupAdjacentBlocks([sq("A", 0, 0), m], ["A", "M"], 15)).toEqual([["A", "M"]]);
  });
  it("joins nested polygons and keeps unmapped names as their own group", () => {
    const f = [sq("A", 0, 0), sq("In", 40 * D, 40 * D, 10 * D, 10 * D)];
    expect(groupAdjacentBlocks(f, ["A", "In", "Ghost"], 15)).toEqual([["A", "In"], ["Ghost"]]);
  });
  it("only groups the selected blocks", () => {
    const f = [sq("A", 0, 0), sq("B", 100 * D, 0), sq("C", 200 * D, 0)];
    expect(groupAdjacentBlocks(f, ["A", "C"], 1)).toEqual([["A"], ["C"]]);
  });
});

describe("area helpers", () => {
  it("shares sum to one and the largest block leads", () => {
    const a = { A: 1, B: 3 };
    expect(areaShares(a, ["A", "B"])).toEqual({ A: 0.25, B: 0.75 });
    expect(largestBlock(a, ["A", "B"])).toBe("B");
  });
});
