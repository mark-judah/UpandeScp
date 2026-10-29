import { describe, expect, it } from "vitest";
import { expandSummary, summaryData, type UnitSummary } from "@/lib/scouting-summary";
import { deriveScoutColors, deriveScoutRoster } from "@/pages/avocado/derive-scouts";

const summary: UnitSummary = {
  aggregated: true,
  total_entries: 90,
  scouts: ["S1", "S2"],
  blocks: ["B1", "B2"],
  hex: [["B1 - Row 1 - Triad 1", 0, 0, 4, "2026-10-05"]],
  pts: [[36683600, 36500, 1, 1, 2, "2026-10-04"]],
};

describe("expandSummary", () => {
  it("turns columns back into entry-shaped rows the page derives from", () => {
    const rows = expandSummary(summary, "Avocado");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ triad: "B1 - Row 1 - Triad 1", scouts_name: "S1", block: "B1", crop_scouted: "Avocado" });
    expect(rows[1]).toMatchObject({ scouts_name: "S2", block: "B2", latitude: "0.036500", longitude: "36.683600" });
    expect(new Set(rows.map((r) => r.name)).size).toBe(2);
  });

  it("colours hexagons and points by scout and counts units per scout", () => {
    const data = summaryData(summary, "Avocado");
    const colours = deriveScoutColors(data);
    expect(colours.get("B1 - Row 1 - Triad 1")).toBeTruthy();
    expect([...colours.keys()].some((k) => k.startsWith("pt:"))).toBe(true);
    expect(deriveScoutRoster(data).map((r) => [r.key, r.trees])).toEqual([["S1", 1], ["S2", 1]]);
  });

  it("is empty for a raw-path answer", () => {
    expect(expandSummary({ aggregated: false, total_entries: 0 }, "Avocado")).toEqual([]);
  });
});
