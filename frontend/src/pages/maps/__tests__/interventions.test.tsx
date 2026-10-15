import { describe, expect, it } from "vitest";
import {
  accuracyLine,
  cardContent,
  placeNodes,
  type InterventionInterval,
} from "../interventions";

const iv = (over: Partial<InterventionInterval> = {}): InterventionInterval => ({
  fromWeek: "2026-W40",
  toWeek: "2026-W41",
  interventions: [
    {
      workOrder: "WO-1",
      date: "2026-10-03",
      chemicals: ["Abamectin 18EC"],
      ingredients: ["abamectin"],
      moa: ["IRAC 6"],
      targets: ["Thrips"],
    },
  ],
  before: { prevalence: 40, reliability: "Good" },
  after: { prevalence: 12, reliability: "Fair" },
  delta: -28,
  direction: "better",
  ...over,
});

describe("placeNodes", () => {
  const frames = ["2026-W39", "2026-W40", "2026-W41", "2026-W43"];
  it("puts the node after the frame it starts in, between the bars", () => {
    expect(Object.keys(placeNodes(frames, [iv()]))).toEqual(["1"]);
  });
  it("lands in the right gap when the target week has no frame", () => {
    const n = placeNodes(frames, [iv({ fromWeek: "2026-W41", toWeek: "2026-W42" })]);
    expect(Object.keys(n)).toEqual(["2"]);
  });
  it("drops an interval that starts before the first frame", () => {
    expect(placeNodes(["2026-W41"], [iv()])).toEqual({});
  });
  it("sorts week 9 before week 10", () => {
    const n = placeNodes(["2026-W09", "2026-W10"], [iv({ fromWeek: "2026-W09", toWeek: "2026-W10" })]);
    expect(Object.keys(n)).toEqual(["0"]);
  });
});

describe("cardContent", () => {
  it("states what was applied and the before/after result", () => {
    const c = cardContent(iv(), "Thrips", { "2026-W40": 30, "2026-W41": 8 });
    expect(c.title).toBe("Between W40 and W41");
    expect(c.applied[0]).toBe(
      "Abamectin 18EC (abamectin; IRAC 6) applied on 2026-10-03 to target Thrips",
    );
    expect(c.result).toBe("Result: prevalence 40% → 12% (−28 pts, better)");
    expect(c.counts).toBe("Observations 30 → 8 (−22)");
    expect(c.reliabilityBefore).toBe("Good");
    expect(c.reliabilityAfter).toBe("Fair");
  });
  it("says worse for a rise and handles missing scouting", () => {
    const w = cardContent(iv({ after: { prevalence: 55, reliability: "Low" }, delta: 15, direction: "worse" }), "Thrips");
    expect(w.result).toContain("+15 pts, worse");
    expect(w.counts).toBeNull();
    const u = cardContent(iv({ after: null, delta: null, direction: "unknown" }), "Thrips");
    expect(u.result).toBe("Result: no comparable scouting");
  });
});

describe("accuracyLine", () => {
  it("joins coverage, zones, scouts and entries", () => {
    expect(
      accuracyLine(
        { prevalence: 10, reliability: "Good", scouts: 3, entries: 120 },
        { coveragePct: 82.4, zonesScouted: 90 },
      ),
    ).toBe("82% covered · 90 zones · 3 scouts · 120 entries");
  });
  it("is empty with nothing known", () => {
    expect(accuracyLine(undefined, undefined)).toBe("");
  });
});
