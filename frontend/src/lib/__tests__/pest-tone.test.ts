import { describe, expect, it } from "vitest";
import { heatStyleOf, splitByHeatStyle, toneBands, toneOf, TONE_ALPHA } from "../pest-tone";
import { LEVEL_ALPHA } from "../heat-style";
import { triadObsColors } from "../triad-colors";
import type { ScoutingEntry } from "../scouting-types";

const rgba = (s: string) => {
  const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(s);
  if (!m) throw new Error(`not rgba: ${s}`);
  return m.slice(1).map(Number);
};
const OLD_BANDS = ["#5bb45d", "#e9a23b", "#dc2626"];

describe("pest tone: the pest's own colour, intensity as opacity", () => {
  it("keeps the hue and ramps the alpha on the roses heat-style levels", () => {
    const [low, mid, high, clean] = toneBands("#3366cc").map(rgba);
    for (const t of [low, mid, high, clean]) expect(t.slice(0, 3)).toEqual([0x33, 0x66, 0xcc]);
    expect(low[3]).toBe(LEVEL_ALPHA[0]);
    expect(mid[3]).toBe(LEVEL_ALPHA[2]);
    expect(high[3]).toBe(LEVEL_ALPHA[3]);
    expect(clean[3]).toBeLessThan(low[3]);
    expect(clean[3]).toBe(TONE_ALPHA.clean);
  });
  it("never uses the old green / amber / red band colours", () => {
    for (const hex of ["#3366cc", "#8b5cf6", "#0f766e"]) {
      const tones = toneBands(hex);
      for (const t of tones) for (const b of OLD_BANDS) expect(t).not.toContain(b);
    }
  });
  it("falls back to a neutral tone for a colour it cannot read", () => {
    expect(rgba(toneOf("var(--x)", 2)).slice(0, 3)).toEqual([90, 90, 84]);
  });
  it("paints hexagons in the pest's tones, clean visits nearly clear", () => {
    const e = (triad: string, n: number) =>
      ({ name: triad + n, triad, pests_scouting_entry: n ? [{ pest: "Thrips", count: n }] : [], diseases_scouting_entry: [] }) as unknown as ScoutingEntry;
    const tones = toneBands("#3366cc");
    const m = triadObsColors([e("H0", 0), e("H1", 2), e("H2", 6), e("H3", 30)], { kind: "pest", name: "Thrips", count: 0 }, tones);
    expect(m.get("H0")).toBe(tones[3]);
    expect(m.get("H1")).toBe(tones[0]);
    expect(m.get("H2")).toBe(tones[1]);
    expect(m.get("H3")).toBe(tones[2]);
  });
});

describe("heat style per block", () => {
  it("defaults by kind: hexagon blocks Solid, the rest Smear; an explicit setting wins", () => {
    expect(heatStyleOf("", true)).toBe("Solid");
    expect(heatStyleOf(undefined, false)).toBe("Smear");
    expect(heatStyleOf("Smear", true)).toBe("Smear");
    expect(heatStyleOf("Solid", false)).toBe("Solid");
    expect(heatStyleOf("weird", false)).toBe("Smear");
  });
  it("splits the outlines: smear blocks feed the field, solid blocks are painted per unit", () => {
    const f = (block: string, heat_style = "") => ({ type: "Feature", geometry: { type: "Polygon", coordinates: [] }, properties: { block, heat_style } });
    const fc = { type: "FeatureCollection", features: [f("P1-B1"), f("P1-B2", "Smear"), f("AVO-A"), f("AVO-B", "Solid")] } as never;
    const { smear, solid } = splitByHeatStyle(fc, new Set(["P1-B1", "P1-B2"]));
    expect(smear.features.map((x: any) => x.properties.block)).toEqual(["P1-B2", "AVO-A"]);
    expect([...solid].sort()).toEqual(["AVO-B", "P1-B1"]);
  });
});
