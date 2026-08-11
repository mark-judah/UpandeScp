import { describe, it, expect } from "vitest";
import { weekLabelTickFormatter, weekTickFormatter } from "./iso-week";

describe("weekLabelTickFormatter", () => {
  it("renders an ISO week label as Week N", () => {
    expect(weekLabelTickFormatter("2026-W29")).toBe("Week 29");
    expect(weekLabelTickFormatter("2026-W02")).toBe("Week 2");
  });

  it("qualifies the year when it differs from the reference year", () => {
    expect(weekLabelTickFormatter("2026-W01", 2026)).toBe("Week 1");
    expect(weekLabelTickFormatter("2025-W52", 2026)).toBe("W52 '25");
  });

  it("returns empty for anything that isn't a week label", () => {
    expect(weekLabelTickFormatter("2026-07-13")).toBe("");
    expect(weekLabelTickFormatter("")).toBe("");
    expect(weekLabelTickFormatter(undefined as unknown as string)).toBe("");
  });

  it("is NOT interchangeable with the daily formatter", () => {
    // The reason both exist: feeding a week label to the daily formatter yields
    // a blank tick rather than an error, so the axis silently empties. Seven
    // dashboard charts still pass YYYY-MM-DD to weekTickFormatter.
    expect(weekTickFormatter("2026-W29")).toBe("");
    expect(weekLabelTickFormatter("2026-07-13")).toBe("");
  });
});
