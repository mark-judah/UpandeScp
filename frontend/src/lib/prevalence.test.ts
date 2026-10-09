import { describe, expect, it } from "vitest";
import { CLUSTERED, figureLine, figureTooltip, type PrevalenceFigures } from "./prevalence";

const base: PrevalenceFigures = {
  prevalence: 34,
  prev: 50,
  margin: 6,
  sections_scouted: 8,
  sections_total: 9,
  reliability: "Good",
  reason: null,
};

describe("figureLine", () => {
  it("reads like the spec: 34% (was 50%) · ±6 · 8/9", () => {
    expect(figureLine(base)).toBe("34% (was 50%) · ±6 · 8/9");
  });

  it('omits "(was …)" when there is no previous week', () => {
    expect(figureLine({ ...base, prev: null })).toBe("34% · ±6 · 8/9");
  });

  it('says "too clustered to judge" when the margin is unknown', () => {
    expect(figureLine({ ...base, margin: null, reason: CLUSTERED, sections_scouted: 1 })).toBe(
      "34% (was 50%) · too clustered to judge · 1/9",
    );
  });

  it("keeps one decimal and scope-wide section totals", () => {
    expect(figureLine({ ...base, prevalence: 33.3, prev: null, margin: 17.8, sections_scouted: 52, sections_total: 63 }))
      .toBe("33.3% · ±17.8 · 52/63");
  });

  it("reports the reason when there are no stations", () => {
    expect(figureLine({ ...base, prevalence: null, reason: "no stations set up" })).toBe("no stations set up");
  });
});

describe("figureTooltip", () => {
  it("explains the four figures, one line each", () => {
    const lines = figureTooltip(base).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^Prevalence:/);
    expect(lines[1]).toMatch(/^Was:/);
    expect(lines[2]).toMatch(/^±:/);
    expect(lines[3]).toMatch(/^8\/9:/);
  });
});
