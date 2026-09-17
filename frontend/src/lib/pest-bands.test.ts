import { describe, expect, it } from "vitest";

import { bandFor, bandRank, judgedValue, specsByPest } from "./pest-bands";

/**
 * These mirror `TestSeverityBands` in
 * `serverscripts/tests/test_block_weekly_report.py`. The jobsheet and the
 * weekly sheet are read by the same people about the same blocks in the same
 * week, so if the two ever disagree about what "High" means, one of them is
 * lying — and the reader has no way to tell which. Keeping the cases identical
 * on both sides is how that gets caught.
 */

const PER_HA = { unit: "Per Hectare", low: 1, moderate: 3, high: 6 };

describe("bandFor", () => {
  it("divides by the block's area, which is the whole point", () => {
    // 30 pests on 3 ha is 10/ha and alarming; the same 30 spread over 30 ha is
    // 1/ha and merely present.
    expect(bandFor(30, PER_HA, 3)).toBe("high");
    expect(bandFor(30, PER_HA, 30)).toBe("low");
  });

  it("treats a threshold as inclusive", () => {
    // The Pest Filter field description defines a threshold as the value AT
    // WHICH severity becomes that band.
    expect(bandFor(18, PER_HA, 3)).toBe("high"); // exactly 6.0/ha
    expect(bandFor(9, PER_HA, 3)).toBe("moderate"); // exactly 3.0/ha
    expect(bandFor(3, PER_HA, 3)).toBe("low"); // exactly 1.0/ha
  });

  it("distinguishes 'below the lowest band' from 'cannot be judged'", () => {
    // "" is an answer: we looked, and it is calm. null is the absence of one.
    expect(bandFor(2, PER_HA, 3)).toBe("");
    expect(bandFor(2, null, 3)).toBeNull();
  });

  it("refuses to judge per hectare without an area", () => {
    // Dividing by a missing denominator invents a figure. Endebess's 64 coffee
    // blocks carry no area at all.
    expect(bandFor(30, PER_HA, null)).toBeNull();
    expect(bandFor(30, PER_HA, 0)).toBeNull();
  });

  it("does not read an unset threshold as a threshold of zero", () => {
    expect(bandFor(10, { unit: "Per Hectare", low: 0, moderate: 0, high: 0 }, 3)).toBeNull();
  });

  it("cannot express a zone percentage for a block", () => {
    // Zones are a greenhouse idea; a block has none. Comparing the raw count
    // instead would silently answer a different question.
    const spec = { unit: "Per Zone %", low: 1, moderate: 2, high: 3 };
    expect(bandFor(10, spec, 3)).toBeNull();
  });

  it("compares the raw count for Per Warehouse", () => {
    const spec = { unit: "Per Warehouse", low: 3, moderate: 8, high: 16 };
    expect(bandFor(10, spec, null)).toBe("moderate");
    expect(bandFor(2, spec, null)).toBe("");
  });
});

describe("judgedValue", () => {
  it("reports the figure the band was actually judged on", () => {
    expect(judgedValue(30, PER_HA, 3)).toEqual({ value: 10, suffix: "/ha" });
    expect(judgedValue(30, { unit: "Per Warehouse", low: 1 }, null)).toEqual({
      value: 30,
      suffix: "",
    });
  });

  it("has nothing to report when the band could not be judged", () => {
    expect(judgedValue(30, PER_HA, null)).toBeNull();
  });
});

describe("bandRank", () => {
  it("ranks pressure, putting the unjudged last rather than dropping them", () => {
    const order = [null, "", "low", "moderate", "high"] as const;
    const ranked = [...order].sort((a, b) => bandRank(b) - bandRank(a));
    expect(ranked[0]).toBe("high");
    expect(ranked[1]).toBe("moderate");
    expect(ranked[2]).toBe("low");
  });
});

describe("specsByPest", () => {
  it("indexes a thresholds bundle by pest name", () => {
    const out = specsByPest([
      { row: "r1", pest: "FCM", unit: "Per Hectare", low: 1, moderate: 3, high: 6, stages: [] },
    ]);
    expect(out.FCM).toEqual({ unit: "Per Hectare", low: 1, moderate: 3, high: 6 });
  });

  it("survives an empty or missing bundle", () => {
    expect(specsByPest(undefined)).toEqual({});
    expect(specsByPest([])).toEqual({});
  });
});
