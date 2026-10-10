import { describe, expect, it } from "vitest";

import { bandRank, judgedLabel, perHectare, type HouseFigure } from "./pest-bands";

/** The figure and band come from the server (thresholds_check.figures_for_houses),
 *  the same ones test_block_weekly_report shades the weekly sheet with. */
const fig = (over: Partial<HouseFigure> = {}): HouseFigure => ({
  measure: "Count", unit: "per tree", value: 1.2, margin: 0.4, reliability: "Fair",
  sections_scouted: 9, sections_total: 9, band: "moderate", action: "Alarming",
  week: "2031-W20", ...over,
});

describe("judgedLabel", () => {
  it("prints the figure in its measure's unit", () => {
    expect(judgedLabel(fig())).toBe("1.2 per tree");
    expect(judgedLabel(fig({ measure: "Percentage", unit: "%", value: 33.3 }))).toBe("33.3%");
  });

  it("has nothing to print without a figure", () => {
    expect(judgedLabel(null)).toBeNull();
    expect(judgedLabel(fig({ value: null }))).toBeNull();
  });
});

describe("perHectare", () => {
  it("divides the week's count by the block's hectares", () => {
    expect(perHectare(30, 3)).toBe(10);
    expect(perHectare(27, 3.4)).toBe(7.94);
  });

  it("refuses without an area rather than inventing one", () => {
    expect(perHectare(30, null)).toBeNull();
    expect(perHectare(30, 0)).toBeNull();
  });
});

describe("bandRank", () => {
  it("ranks pressure, putting the unjudged last rather than dropping them", () => {
    const order = [null, "", "low", "moderate", "high"] as const;
    const ranked = [...order].sort((a, b) => bandRank(b) - bandRank(a));
    expect(ranked.slice(0, 3)).toEqual(["high", "moderate", "low"]);
  });
});
