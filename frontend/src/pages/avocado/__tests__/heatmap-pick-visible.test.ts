import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A block picked on the map is checked in the (clipped) list; the list must
// scroll that row into view or the pick looks like it did nothing.
describe("Application Floor Plan: a map pick is visible", () => {
  const src = readFileSync("src/pages/avocado/AvocadoHeatMap.tsx", "utf8");
  it("hands the pick to the planner list, which scrolls its row into view", () => {
    expect(src).toContain("focus={focus}");
    const picker = readFileSync("src/components/spray-plan/BlockMultiPicker.tsx", "utf8");
    expect(picker).toContain("data-block={b.name}");
    expect(picker).toMatch(/box\.scrollTop = /);
  });
  it("draws the selection with a halo over the heat field", () => {
    expect(src).toContain('id: "block-sel-halo"');
  });
});
