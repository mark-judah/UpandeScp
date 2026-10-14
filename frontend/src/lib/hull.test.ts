import { describe, expect, it } from "vitest";
import { closedRing, convexHull, outlinePath } from "./hull";

describe("convexHull", () => {
  it("keeps the outer corners", () => {
    expect(convexHull([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1]])).toEqual([[0, 0], [2, 0], [2, 2], [0, 2]]);
  });
  it("collapses a straight bed to its two ends and drops repeats", () => {
    expect(convexHull([[0, 0], [1, 1], [2, 2]])).toEqual([[0, 0], [2, 2]]);
    expect(convexHull([[1, 1], [1, 1]])).toEqual([[1, 1]]);
  });
  it("writes a closed SVG path and a closed ring", () => {
    expect(outlinePath([[0, 0], [2, 0], [1, 1.234]])).toBe("M0 0 L2 0 L1 1.23 Z");
    expect(outlinePath([])).toBe("");
    expect(closedRing([[0, 0], [1, 0]])).toEqual([[0, 0], [1, 0], [0, 0]]);
  });
});
