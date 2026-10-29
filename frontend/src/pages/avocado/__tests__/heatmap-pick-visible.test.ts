import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A block picked on the map is checked in the (clipped) list; the list must
// scroll that row into view or the pick looks like it did nothing.
describe("Application Plan map pick is visible in the list", () => {
  const src = readFileSync("src/pages/avocado/AvocadoHeatMap.tsx", "utf8");
  it("tags rows and scrolls the selected one into view", () => {
    expect(src).toContain("data-block={b.tag}");
    expect(src).toContain("ref={listRef}");
    expect(src).toMatch(/box\.scrollTop = /);
  });
  it("draws the selection with a halo over the heat field", () => {
    expect(src).toContain('id: "block-sel-halo"');
  });
});
