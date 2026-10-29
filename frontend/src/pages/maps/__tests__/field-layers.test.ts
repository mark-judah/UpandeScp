import { describe, expect, it } from "vitest";
import { blockColors, diffColors, pointFeatures } from "../field-layers";
import type { ScoutingEntry } from "@/lib/scouting-types";

const e = (o: Partial<ScoutingEntry>) => ({ name: "S", ...o }) as ScoutingEntry;

describe("diffColors", () => {
  const known = (k: string) => k !== "unknown";
  it("sets only what changed and clears what vanished", () => {
    const prev = new Map([["a", "#1"], ["b", "#2"], ["c", "#3"]]);
    const next = new Map([["a", "#1"], ["b", "#9"], ["d", "#4"], ["unknown", "#5"]]);
    const d = diffColors(prev, next, known);
    expect(d.set).toEqual([["b", "#9"], ["d", "#4"]]);
    expect(d.clear).toEqual(["c"]);
  });
  it("sets everything on the first paint", () => {
    expect(diffColors(null, new Map([["a", "#1"]]), known).set).toEqual([["a", "#1"]]);
  });
});

describe("blockColors", () => {
  it("is the colour most of the block's coloured visits share", () => {
    const colors = new Map([["H1", "#r"], ["H2", "#r"], ["H3", "#g"]]);
    const entries = [e({ block: "B1", triad: "H1" }), e({ block: "B1", triad: "H2" }), e({ block: "B1", triad: "H3" }), e({ block: "B2", triad: "none" })];
    const m = blockColors(entries, colors);
    expect(m.get("B1")).toBe("#r");
    expect(m.has("B2")).toBe(false);
  });
});

describe("pointFeatures", () => {
  it("keeps only located visits that carry no tree or hexagon", () => {
    const entries = [
      e({ name: "A", block: "B", latitude: "0.04", longitude: "36.67" }),
      e({ name: "B", block: "B", triad: "H1", latitude: "0.04", longitude: "36.67" }),
      e({ name: "C", block: "B" }),
    ];
    const colors = new Map([["pt:A", "#abc"], ["H1", "#def"]]);
    const fc = pointFeatures(entries, colors);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry.coordinates).toEqual([36.67, 0.04]);
    expect(fc.features[0].properties.c).toBe("#abc");
  });
});
