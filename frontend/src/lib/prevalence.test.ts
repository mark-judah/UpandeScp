import { describe, expect, it } from "vitest";
import { CLUSTERED, figureLine, figureTooltip, pressureText, signsSuffix, type PrevalenceFigures } from "./prevalence";

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
  it("adds the pest's signs at the end when it has any", () => {
    const signs = { ...base, prevalence: 66.7, prev: null };
    expect(figureLine({ ...base, prev: null, signs })).toBe("34% · ±6 · 8/9 · signs 66.7%");
    expect(figureLine({ ...base, prev: null, signs: null })).toBe("34% · ±6 · 8/9");
    expect(figureLine({ ...base, prevalence: null, reason: "no stations set up", signs })).toBe("no stations set up");
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

  it("explains the signs line only when there is one", () => {
    expect(figureTooltip({ ...base, signs: { ...base, prevalence: 30 } })).toContain("Signs: share of scouted stations showing signs of it");
    expect(figureTooltip(base)).not.toContain("Signs:");
  });
});

describe("signsSuffix and pressureText", () => {
  it("writes ' · signs N%' and nothing when there are none", () => {
    expect(signsSuffix(66.7)).toBe(" · signs 66.7%");
    expect(signsSuffix(0)).toBe(" · signs 0%");
    expect(signsSuffix(null)).toBe("");
    expect(signsSuffix(undefined)).toBe("");
  });

  it("puts the row's signs beside a pressure bar's value", () => {
    expect(pressureText(33.3, { payload: { signs: { prevalence: 66.7 } } })).toBe("33.3% · signs 66.7%");
    expect(pressureText(33.3, { payload: { signs: null } })).toBe("33.3%");
    expect(pressureText(33.3, undefined)).toBe("33.3%");
    expect(pressureText(null, { payload: { signs: { prevalence: 1 } } })).toBe("—");
  });
});
