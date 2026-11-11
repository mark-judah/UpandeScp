import { describe, expect, it } from "vitest";
import { clampNotPast, isPast, nextSlot } from "../schedule";

const NOW = new Date(2026, 10, 11, 10, 7, 0); // 11 Nov 2026 10:07 local

describe("no planning in the past", () => {
  it("rounds up to the next 5-minute slot", () => {
    expect(nextSlot(NOW)).toBe("10:10");
    expect(nextSlot(new Date(2026, 10, 11, 10, 10, 0))).toBe("10:10");
  });
  it("pulls a past time today up to the next slot", () => {
    expect(clampNotPast("2026-11-11 06:00:00", NOW)).toBe("2026-11-11 10:10:00");
  });
  it("pulls a past day to today", () => {
    expect(clampNotPast("2026-11-09 14:00:00", NOW)).toBe("2026-11-11 10:10:00");
  });
  it("leaves now-ish and future values alone", () => {
    expect(clampNotPast("2026-11-11 10:07:00", NOW)).toBe("2026-11-11 10:07:00");
    expect(clampNotPast("2026-11-11 15:00:00", NOW)).toBe("2026-11-11 15:00:00");
    expect(clampNotPast("2026-11-12 06:00:00", NOW)).toBe("2026-11-12 06:00:00");
  });
  it("reports past values", () => {
    expect(isPast("2026-11-11 09:00:00", NOW)).toBe(true);
    expect(isPast("2026-11-12 09:00:00", NOW)).toBe(false);
  });
});
