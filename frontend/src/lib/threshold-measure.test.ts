import { describe, expect, it } from "vitest";

import {
  bandsAscending,
  countBandNote,
  effectiveMeasure,
  formatBandValue,
  thresholdMapFromBundle,
  unitFor,
} from "./threshold-measure";
import type { ThresholdsBundle } from "./thresholds-api";

/** Mirrors test_threshold_core_pure (threshold_bands.py) — the server re-checks on save. */
describe("bandsAscending", () => {
  it("needs the bands that are set to rise strictly", () => {
    expect(bandsAscending(1, 2, 3)).toBe(true);
    expect(bandsAscending(0, 1, 2)).toBe(true);
    expect(bandsAscending(0, 0, 0)).toBe(true);
    expect(bandsAscending(1, 0.4, 2)).toBe(false); // Rose Thrips on kaitet.local
    expect(bandsAscending(5, 5, 10)).toBe(false);
    expect(bandsAscending(-1, 2, 3)).toBe(false);
  });
});

describe("measure and unit", () => {
  it("reads a tick-box stage under a Count row as a share", () => {
    expect(effectiveMeasure("Count")).toBe("Count");
    expect(effectiveMeasure("Count", "Count")).toBe("Count");
    expect(effectiveMeasure("Count", "Checkbox")).toBe("Percentage");
    expect(effectiveMeasure("Percentage", "Count")).toBe("Percentage");
  });

  it("labels the unit per crop station", () => {
    expect(unitFor("Percentage", "tree")).toBe("%");
    expect(unitFor("Count", "tree")).toBe("per tree");
    expect(unitFor("Count", "zone")).toBe("per zone");
    expect(formatBandValue(30, "%")).toBe("30%");
    expect(formatBandValue(5, "per zone")).toBe("5 per zone");
  });
});

const bundle: ThresholdsBundle = {
  crop: "Rose",
  station: "zone",
  pests: [
    {
      row: "p1", pest: "Thrips", measure: "Count", count_allowed: true, invalid: false,
      low: 0, moderate: 1, high: 2,
      stages: [
        { row: "s1", stage: "Adult", reading_type: "Count", low: 0, moderate: 3, high: 6 },
        { row: "s2", stage: "Damages", reading_type: "Checkbox", low: 0, moderate: 10, high: 30 },
      ],
    },
    { row: "p2", pest: "Aphids", measure: "Percentage", count_allowed: true, invalid: true,
      low: 1, moderate: 0.4, high: 2, stages: [] },
    { row: "p3", pest: "Mites", measure: "Percentage", count_allowed: true, invalid: false,
      low: 0, moderate: 0, high: 0, stages: [] },
  ],
  diseases: [
    { row: "d1", disease: "Botrytis", measure: "Percentage", count_allowed: false, invalid: false,
      low: 0, moderate: 20, high: 40, stages: [] },
  ],
};

describe("thresholdMapFromBundle", () => {
  it("keys bands by kind, name and stage with their measure and unit", () => {
    const m = thresholdMapFromBundle(bundle);
    expect(m.get("pest::Thrips::")).toEqual({ low: 0, moderate: 1, high: 2, measure: "Count", unit: "per zone" });
    expect(m.get("pest::Thrips::Adult")?.unit).toBe("per zone");
    expect(m.get("pest::Thrips::Damages")).toEqual({ low: 0, moderate: 10, high: 30, measure: "Percentage", unit: "%" });
    expect(m.get("disease::Botrytis::")?.unit).toBe("%");
  });

  it("leaves out unset and misordered bands, as the server does", () => {
    const m = thresholdMapFromBundle(bundle);
    expect(m.has("pest::Aphids::")).toBe(false);
    expect(m.has("pest::Mites::")).toBe(false);
    expect(thresholdMapFromBundle(null).size).toBe(0);
  });

  it("describes count bands Trends cannot draw on a share axis", () => {
    expect(countBandNote({ low: 0, moderate: 1, high: 2, measure: "Count", unit: "per zone" })).toBe(
      "Count thresholds (per zone): Mod 1 · High 2 — Trends plots the share of stations, so they are not drawn here",
    );
  });
});
