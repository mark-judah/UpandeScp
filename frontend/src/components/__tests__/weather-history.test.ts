import { describe, it, expect } from "vitest";
import { fmtDelta } from "@/components/WeatherHistory";

describe("fmtDelta — week-on-week weather change", () => {
  it("signs a rise and a fall", () => {
    expect(fmtDelta(16)).toBe("+16.0");
    expect(fmtDelta(-3.1)).toBe("−3.1"); // unicode minus keeps columns aligned
  });

  it("renders no change without a sign", () => {
    expect(fmtDelta(0)).toBe("0");
  });

  it("renders an em dash when there is no previous week to compare", () => {
    expect(fmtDelta(null)).toBe("—");
    expect(fmtDelta(undefined as unknown as number)).toBe("—");
  });

  it("appends a unit when given", () => {
    expect(fmtDelta(16, "mm")).toBe("+16.0mm");
    expect(fmtDelta(0, "mm")).toBe("0mm");
  });
});
