import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("Trends reference lines follow the row's measure", () => {
  const panel = src("../ChartPanel.tsx");
  const page = src("../../Trends.tsx");

  it("draws only share bands and describes count bands instead", () => {
    expect(panel).toContain('measuredBand.measure !== "Count"');
    expect(panel).toContain('data-testid="count-band-note"');
    expect(panel).toContain("countBandNote(");
  });

  it("labels each line in the band's unit", () => {
    expect(panel).toContain("formatBandValue(value, unit)");
    expect(panel).not.toMatch(/\$\{value\}%/);
  });

  it("builds the lookup from the bundle helper", () => {
    expect(page).toContain("thresholdMapFromBundle(thresholdBundle)");
  });
});
