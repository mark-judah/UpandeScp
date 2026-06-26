import { describe, it, expect } from "vitest";
import { computeAreaHa } from "@/lib/application-plan-area";

// 142 beds: 60 are FAR041, 82 are FAR149; beds numbered 1..142.
const beds = Array.from({ length: 142 }, (_, i) => ({
  bed: String(i + 1),
  variety: i < 60 ? "FAR041" : "FAR149",
}));

describe("computeAreaHa", () => {
  it("full greenhouse is exactly 1 ha", () => {
    expect(computeAreaHa("Full Greenhouse", beds, new Set(), new Set())).toBe(1);
  });

  it("variety scope is bed-count share of 1 ha", () => {
    const ha = computeAreaHa("Specific Variety", beds, new Set(["FAR041"]), new Set());
    expect(ha).toBeCloseTo(60 / 142, 6);
  });

  it("bed scope is bed-count share of 1 ha", () => {
    const sel = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    const ha = computeAreaHa("Specific Bed(s)", beds, new Set(), sel);
    expect(ha).toBeCloseTo(10 / 142, 6);
  });

  it("returns 0 when greenhouse has no beds", () => {
    expect(computeAreaHa("Full Greenhouse", [], new Set(), new Set())).toBe(0);
  });

  it("returns 0 for unknown scope", () => {
    expect(computeAreaHa("", beds, new Set(), new Set())).toBe(0);
  });
});
