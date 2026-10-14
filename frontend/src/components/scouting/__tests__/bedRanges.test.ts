import { describe, expect, it } from "vitest";
import { bedRanges } from "../ScoutRouteCard";

const beds = (...n: number[]) => n.map((x) => `GH 20 - KR - Bed ${x}`);
const run = (a: number, b: number, step = 1) => {
  const out: number[] = [];
  for (let i = a; i <= b; i += step) out.push(i);
  return out;
};

describe("bedRanges", () => {
  it("collapses consecutive runs", () => {
    expect(bedRanges(beds(...run(212, 256), ...run(480, 492)))).toBe("58 beds · 212–256, 480–492");
  });
  it("collapses step-2 runs", () => {
    expect(bedRanges(beds(212, 214, 216, 218))).toBe("4 beds · 212–218");
  });
  it("lists short runs and singles, sorts and de-duplicates", () => {
    expect(bedRanges(beds(9, 3, 3, 4, 20))).toBe("4 beds · 3, 4, 9, 20");
  });
  it("handles one bed, none, and unnumbered names", () => {
    expect(bedRanges(beds(7))).toBe("1 bed · 7");
    expect(bedRanges([])).toBe("");
    expect(bedRanges(["Nursery", ...beds(1, 2, 3)])).toBe("4 beds · 1–3, Nursery");
  });
});
