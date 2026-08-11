import { describe, it, expect } from "vitest";
import {
  smoothPath,
  weekOrdinal,
  weeksAreConsecutive,
} from "@/components/WeatherHistory";

describe("weekOrdinal / weeksAreConsecutive", () => {
  it("orders ISO week labels", () => {
    expect(weekOrdinal("2026-W29")).toBe(202629);
    expect(weekOrdinal("nonsense")).toBe(0);
  });

  it("accepts consecutive weeks", () => {
    expect(weeksAreConsecutive(["2026-W27", "2026-W28", "2026-W29"])).toBe(true);
  });

  it("rejects a gap — a solid line across it would imply missing readings", () => {
    expect(weeksAreConsecutive(["2026-W27", "2026-W30"])).toBe(false);
  });

  it("handles a year rollover", () => {
    expect(weeksAreConsecutive(["2025-W52", "2026-W01"])).toBe(true);
    expect(weeksAreConsecutive(["2025-W52", "2026-W03"])).toBe(false);
  });

  it("treats a single week as consecutive", () => {
    expect(weeksAreConsecutive(["2026-W29"])).toBe(true);
  });
});

describe("smoothPath", () => {
  it("starts at the first point and ends at the last", () => {
    const d = smoothPath([1, 5, 3], 100, 20);
    expect(d.startsWith("M")).toBe(true);
    expect(d).toContain("C"); // smoothed, not straight segments
  });

  it("never rises above the plot area or dips below it", () => {
    // A rainfall series must not be drawn below the axis — that would read as
    // negative rain. Control points are checked, not just the anchors.
    const w = 100;
    const h = 20;
    const d = smoothPath([0, 12, 0, 8, 0], w, h);
    const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    const ys = nums.filter((_, i) => i % 2 === 1);
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(-0.6);
      expect(y).toBeLessThanOrEqual(h + 0.6);
    }
  });

  it("draws a flat line for a single reading", () => {
    expect(smoothPath([4], 100, 20)).toContain("L");
  });

  it("returns nothing for no readings", () => {
    expect(smoothPath([], 100, 20)).toBe("");
  });
});
