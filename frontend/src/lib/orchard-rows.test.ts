import { describe, it, expect } from "vitest";
import { expandTreeRows, type OrchardTreeRow } from "./orchard-rows";

describe("expandTreeRows", () => {
  it("interpolates a linear row evenly and rebuilds names", () => {
    const rows: OrchardTreeRow[] = [
      { k: "l", p: "R_T", a: [0, 0], b: [4, 0], n: 5 },
    ];
    const { names, coords } = expandTreeRows(rows);
    expect(names).toEqual(["R_T1", "R_T2", "R_T3", "R_T4", "R_T5"]);
    expect(coords).toEqual([0, 0, 1, 0, 2, 0, 3, 0, 4, 0]);
  });

  it("uses explicit coords verbatim with prefix names", () => {
    const rows: OrchardTreeRow[] = [
      { k: "e", p: "R_T", c: [0, 0, 9, 9], n: 2 },
    ];
    const { names, coords } = expandTreeRows(rows);
    expect(names).toEqual(["R_T1", "R_T2"]);
    expect(coords).toEqual([0, 0, 9, 9]);
  });

  it("uses explicit names when provided", () => {
    const rows: OrchardTreeRow[] = [
      { k: "e", names: ["A", "B"], c: [1, 1, 2, 2], n: 2 },
    ];
    const { names } = expandTreeRows(rows);
    expect(names).toEqual(["A", "B"]);
  });

  it("handles a single-tree linear row", () => {
    const rows: OrchardTreeRow[] = [{ k: "l", p: "R_T", a: [3, 7], b: [3, 7], n: 1 }];
    const { names, coords } = expandTreeRows(rows);
    expect(names).toEqual(["R_T1"]);
    expect(coords).toEqual([3, 7]);
  });
});
