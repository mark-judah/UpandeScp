import { describe, expect, it } from "vitest";

import { alertFigureLine, ghActionBadge, type CreatorAlert } from "./scouting-alerts-api";

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
