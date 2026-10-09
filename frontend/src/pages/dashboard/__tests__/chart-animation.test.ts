import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Spec D6: every dashboard chart reveals left to right through RevealLTR; no
 *  recharts series keeps its own animation (a vertical Bar's default animation
 *  grows from the middle, and two animations fight). Scans the source so a new
 *  chart that forgets either rule fails here. */
const DASHBOARD = ["OverviewTab", "PestsTab", "DiseasesTab", "TrapsTab", "FcmTab", "GreenhouseModal", "TrendStrip"];
const SERIES = /<(Area|Bar|Line|Pie|Scatter|Radar|RadialBar|Funnel)[\s>]/g;
const OFF = /isAnimationActive=\{false\}/g;
const CONTAINER = /<ChartContainer[\s>]/g;
const WRAPPED = /<RevealLTR[^>]*>\s*<ChartContainer[\s>]/g;

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe("dashboard charts reveal left to right", () => {
  for (const name of DASHBOARD) {
    const src = source(`../${name}.tsx`);

    it(`${name}: every recharts series has its own animation off`, () => {
      expect(count(src, SERIES)).toBeGreaterThan(0);
      expect(count(src, OFF)).toBe(count(src, SERIES));
    });

    it(`${name}: every chart sits inside RevealLTR`, () => {
      expect(count(src, CONTAINER)).toBeGreaterThan(0);
      expect(count(src, WRAPPED)).toBe(count(src, CONTAINER));
    });
  }

  const OTHERS = [
    ["Trends ChartPanel", "../../trends/ChartPanel.tsx"],
    ["CsuLevels", "../../../components/CsuLevels.tsx"],
    ["ChemicalStoreComparison", "../../../components/ChemicalStoreComparison.tsx"],
    ["StoreBucketPanel", "../../../components/StoreBucketPanel.tsx"],
  ];
  for (const [label, rel] of OTHERS) {
    const src = source(rel);

    it(`${label}: every series has its own animation off`, () => {
      expect(count(src, SERIES)).toBeGreaterThan(0);
      expect(count(src, OFF)).toBe(count(src, SERIES));
    });

    it(`${label}: every chart sits inside RevealLTR`, () => {
      expect(count(src, CONTAINER)).toBeGreaterThan(0);
      expect(count(src, WRAPPED)).toBe(count(src, CONTAINER));
    });
  }
});
