import { describe, expect, it } from "vitest";
import { formatPerHa, perHaLabel, perHaLongLabel } from "./cumulative-api";

describe("per-ha formatting", () => {
  it("one decimal from 10, two below", () => {
    expect(formatPerHa(12.44)).toBe("12.4");
    expect(formatPerHa(0.46)).toBe("0.46");
    expect(formatPerHa(3)).toBe("3.00");
    expect(formatPerHa(9.999)).toBe("10.0");
  });
  it("a missing figure is a dash, never zero", () => {
    expect(formatPerHa(null)).toBe("—");
    expect(perHaLabel(undefined)).toBe("—");
    expect(perHaLongLabel(null)).toContain("no block area");
  });
  it("labels the unit and the window", () => {
    expect(perHaLabel(12.4)).toBe("12.4 / ha");
    expect(perHaLongLabel(12.4)).toBe("12.4 / ha (cumulative this round)");
  });
});
