import { describe, expect, it } from "vitest";
import { isWideEnough, rangeDays, targetLabel, widenedRange } from "@/lib/widen-range";

describe("widen-range", () => {
  it("widens back from the end date", () => {
    expect(widenedRange("2026-10-12", 12)).toEqual({ from: "2026-07-20", to: "2026-10-12" });
    expect(widenedRange("2026-01-10", 8).from).toBe("2025-11-15");
  });
  it("counts inclusive days and knows when it is wide enough", () => {
    expect(rangeDays("2026-10-01", "2026-10-07")).toBe(7);
    expect(isWideEnough("2026-10-01", "2026-10-12")).toBe(false);
    expect(isWideEnough("2026-07-20", "2026-10-12")).toBe(true);
  });
  it("names the target with full house names", () => {
    expect(targetLabel(["Kapkolia GH 15 - KR"], ["Spidermites"])).toBe("Kapkolia GH 15 · Spidermites");
    expect(targetLabel(["A GH 1 - KR", "A GH 2 - KR", "A GH 3 - KR"], [])).toBe("A GH 1, A GH 2 +1");
  });
});
