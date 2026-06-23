import { describe, it, expect } from "vitest";
import { niceCeilPercent } from "../ChartPanel";

describe("niceCeilPercent — adaptive Y-axis ceiling", () => {
  it("zooms a low-coverage chart (avocado ~5.8%) to a 10% axis", () => {
    expect(niceCeilPercent(5.8)).toBe(10);
    expect(niceCeilPercent(0.12)).toBe(1);
    expect(niceCeilPercent(2.1)).toBe(3);
  });

  it("keeps headroom so the peak never touches the top", () => {
    // 10% * 1.15 = 11.5 → next nice step is 15, not 10.
    expect(niceCeilPercent(10)).toBe(15);
  });

  it("scales up for high-coverage charts (roses) and caps at 100", () => {
    expect(niceCeilPercent(45)).toBe(60);
    expect(niceCeilPercent(95)).toBe(100);
  });

  it("handles empty / zero / invalid data", () => {
    expect(niceCeilPercent(0)).toBe(1);
    expect(niceCeilPercent(-5)).toBe(1);
    expect(niceCeilPercent(NaN)).toBe(1);
  });
});
