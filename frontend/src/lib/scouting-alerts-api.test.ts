import { describe, expect, it } from "vitest";

import { alertFigureLine, alertLevel, ghActionBadge, isTreeHotSpot, type CreatorAlert } from "./scouting-alerts-api";

const a = (over: Partial<CreatorAlert> = {}): CreatorAlert => ({
  name: "SA-1", warehouse: "GH 01", observation: "Thrips", stage: "", action: "Spray advised",
  value: 33.3, unit: "%", reliability: "Fair", iso_week: "2031-W20", status: "Open",
  margin: 18, sections_scouted: 9, sections_total: 9, ...over,
});

describe("alertFigureLine", () => {
  it("prints the figure in its unit with margin and sections", () => {
    expect(alertFigureLine(a())).toBe("33.3% · ±18 · 9/9");
    expect(alertFigureLine(a({ unit: "per zone", value: 1.2, margin: null, sections_scouted: 1 }))).toBe(
      "1.2 per zone · too clustered to judge · 1/9",
    );
  });
});

describe("ghActionBadge", () => {
  it("shows the worst spray action on the greenhouse", () => {
    expect(ghActionBadge([a({ action: "Scout first" }), a()])).toBe("Spray advised");
    expect(ghActionBadge([a({ action: "Scout first" })])).toBe("Scout first");
    expect(ghActionBadge([a({ action: "Alarming" as CreatorAlert["action"] })])).toBeNull();
    expect(ghActionBadge(undefined)).toBeNull();
  });
});

describe("alertFigureLine for a hot spot", () => {
  const spot = a({ value: 80, margin: null, sections_scouted: 5, sections_total: 1 });
  it("prints the section figure and its station count, never a margin", () => {
    expect(alertFigureLine({ ...spot, alert_type: "Hot spot" })).toBe("80% · 5 stations in this section");
  });
  it("puts the house figure beside it and names the crop's stations", () => {
    expect(alertFigureLine({ ...spot, alert_type: "Hot spot", house_value: 8.9, station_word: "zone" })).toBe(
      "80% (house 8.9%) · 5 zones in this section",
    );
    expect(
      alertFigureLine({ ...spot, unit: "per tree", value: 3, alert_type: "Hot spot", house_value: 0.4, station_word: "tree" }),
    ).toBe("3 per tree (house 0.4 per tree) · 5 trees in this section");
  });
});

describe("alertFigureLine for a block crop (per hectare)", () => {
  it("reads as per ha this week, with no margin or section count", () => {
    const line = alertFigureLine({
      value: 12.4, unit: "/ ha this week", margin: null, sections_scouted: 0, sections_total: 0,
    });
    expect(line).toBe("12.4 / ha this week · over its threshold");
    expect(line).not.toMatch(/clustered|\/9/);
  });
  it("keeps two decimals under 10", () => {
    expect(
      alertFigureLine({ value: 0.46, unit: "/ ha this week", margin: null, sections_scouted: 0, sections_total: 0 }),
    ).toContain("0.46 / ha this week");
  });
});

describe("both levels of a block crop", () => {
  const block = {
    value: 4.6, unit: "/ ha this week", margin: null, sections_scouted: 0, sections_total: 0, threshold: 4,
  };
  const spot = {
    value: 9, unit: "per tree", margin: null, sections_scouted: 7, sections_total: 0, alert_type: "Tree hot spot" as const,
    section_label: "7 trees · rows 12–14, trees 3–9 · High, peak 9 per tree", band: "High" as const,
  };
  it("labels the block line with its threshold", () => {
    expect(alertFigureLine(block)).toBe("Block: 4.60 / ha this week (line 4.00)");
  });
  it("labels a hot spot with its trees, rows and band", () => {
    expect(alertFigureLine(spot)).toBe(
      "Hot spot: 7 trees in rows 12–14 over the per-tree High band · worst tree 9 per tree",
    );
  });
  it("tells the two levels apart", () => {
    expect(alertLevel(block)).toBe("Block");
    expect(alertLevel(spot)).toBe("Hot spot");
    expect(alertLevel({ unit: "%" })).toBeNull();
    expect(isTreeHotSpot(spot)).toBe(true);
  });
});
