import { describe, expect, it } from "vitest";
import {
  FG_LAYERS,
  HEXA_LINE_ZOOM,
  TRI_LINE_ZOOM,
  TRI_ZOOM,
  addFieldLayers,
  setFieldVisibility,
  blockColors,
  diffColors,
  pointFeatures,
} from "../field-layers";
const EMPTY_SET = { fc: { type: "FeatureCollection", features: [] as unknown[] } };
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

function fakeMap() {
  const layers: Array<Record<string, unknown>> = [];
  const sources = new Map<string, unknown>();
  const vis = new Map<string, string>();
  const map = {
    getLayer: (id: string) => layers.find((l) => l.id === id),
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, s: unknown) => sources.set(id, s),
    addLayer: (l: Record<string, unknown>) => layers.push(l),
    setLayoutProperty: (id: string, _p: string, v: string) => vis.set(id, v),
  };
  return { map: map as never, layers, sources, vis };
}

describe("field layers", () => {
  it("registers triangle fill/line and Hexa line at the agreed zooms, with no row layer", () => {
    const f = fakeMap();
    addFieldLayers(f.map, EMPTY_SET, { type: "FeatureCollection", features: [] }, []);
    const z = (id: string) => f.layers.find((l) => l.id === id)?.minzoom;
    // Each layer fades in over the half zoom before its threshold rather than popping in at it.
    expect(z("fg-tri-fill")).toBe(15.5 - FADE_DZ);
    expect(z("fg-tri-line")).toBe(18 - FADE_DZ);
    expect(z("fg-hexa-line")).toBe(16.5 - FADE_DZ);
    const op = (id: string, k: string) => (f.layers.find((l) => l.id === id)?.paint as Record<string, unknown[]>)[k];
    expect(op("fg-hexa-line", "line-opacity").slice(3)).toEqual([16, 0, 16.5, 0.55]);
    expect(op("fg-tri-fill", "fill-opacity").slice(3, 6)).toEqual([15, 0, 15.5]);
    expect([TRI_ZOOM, TRI_LINE_ZOOM, HEXA_LINE_ZOOM]).toEqual([15.5, 18, 16.5]);
    expect(f.layers.some((l) => l.id === "fg-rows")).toBe(false);
    expect(FG_LAYERS).not.toContain("fg-rows");
    expect(f.sources.has("fg-rows")).toBe(false);
  });
  it("a block without triads draws no triangles", () => {
    const f = fakeMap();
    const set = EMPTY_SET;
    addFieldLayers(f.map, set, { type: "FeatureCollection", features: [] }, []);
    expect((f.sources.get("fg-tri") as { data: { features: unknown[] } }).data.features).toHaveLength(0);
  });
  it("toggles triangles and Hexa lines independently", () => {
    const f = fakeMap();
    addFieldLayers(f.map, EMPTY_SET, { type: "FeatureCollection", features: [] }, []);
    setFieldVisibility(f.map, { tri: false, hexa: true });
    expect(f.vis.get("fg-tri-fill")).toBe("none");
    expect(f.vis.get("fg-tri-line")).toBe("none");
    expect(f.vis.get("fg-hexa-line")).toBe("visible");
  });
});

import { FADE_DZ, UNSCOUTED_TRI, setFieldTriZoom, visitedUnits } from "../field-layers";

describe("visitedUnits", () => {
  const e = (o: Partial<ScoutingEntry>) => ({ name: "x", block: "B1", ...o }) as ScoutingEntry;
  it("counts distinct coloured trees and triangles, on the shown blocks only", () => {
    const colors = new Map([["T1", "#f00"], ["B1 - Hexa 1 - Triad 1", "#0f0"], ["B2 - Hexa 1 - Triad 1", "#0f0"]]);
    const entries = [
      e({ tree: "T1" }),
      e({ tree: "T1" }),
      e({ triad: "B1 - Hexa 1 - Triad 1" }),
      e({ triad: "B1 - Hexa 1 - Triad 1" }),
      e({ triad: "B2 - Hexa 1 - Triad 1", block: "B2" }),
      e({ triad: "B1 - Hexa 9 - Triad 1" }), // not coloured
    ];
    expect(visitedUnits(entries, colors)).toEqual({ trees: 1, triads: 2 });
    expect(visitedUnits(entries, colors, (b) => b === "B1")).toEqual({ trees: 1, triads: 1 });
  });
});

describe("big-farm triangle zoom", () => {
  it("moves the triangle fade to the new threshold", () => {
    const calls: unknown[][] = [];
    const map = {
      getLayer: () => true,
      setLayerZoomRange: (...a: unknown[]) => calls.push(["range", ...a]),
      setPaintProperty: (...a: unknown[]) => calls.push(["paint", ...a]),
    };
    setFieldTriZoom(map as never, 17.5);
    expect(calls).toContainEqual(["range", "fg-tri-fill", 17, 24]);
    expect(calls).toContainEqual(["range", "fg-tri-line", 17.5, 24]);
    const fill = calls.find((c) => c[0] === "paint" && c[1] === "fg-tri-fill")![3] as unknown[];
    expect(fill.slice(3, 6)).toEqual([17, 0, 17.5]);
  });
});

import { addFieldChunk, paintLatticeColors, removeFieldChunks } from "../field-layers";

describe("farm chunks", () => {
  const chunkMap = () => {
    const layers: Array<Record<string, unknown>> = [];
    const sources = new Map<string, unknown>();
    const states: unknown[][] = [];
    const map = {
      getLayer: (id: string) => layers.find((l) => l.id === id),
      getSource: (id: string) => sources.get(id),
      addSource: (id: string, s: unknown) => sources.set(id, s),
      addLayer: (l: Record<string, unknown>) => layers.push(l),
      removeLayer: (id: string) => layers.splice(layers.findIndex((l) => l.id === id), 1),
      removeSource: (id: string) => sources.delete(id),
      getStyle: () => ({ layers, sources: Object.fromEntries(sources) }),
      setFeatureState: (...a: unknown[]) => states.push(["set", ...a]),
      removeFeatureState: (...a: unknown[]) => states.push(["clear", ...a]),
    };
    return { map: map as never, layers, sources, states };
  };
  it("adds a chunk once, with fading triangle, outline and Hexa layers, and removes them all", () => {
    const f = chunkMap();
    addFieldChunk(f.map, "0", "blob:x", 17.5, { tri: true, hexa: true });
    addFieldChunk(f.map, "0", "blob:x", 17.5, { tri: true, hexa: true });
    expect(f.layers.map((l) => [l.id, l.minzoom])).toEqual([
      ["fg-c-0-fill", 17],
      ["fg-c-0-tline", 17.5],
      ["fg-c-0-hexa", 16],
    ]);
    expect((f.sources.get("fg-c-0") as { maxzoom: number }).maxzoom).toBe(18);
    removeFieldChunks(f.map);
    expect(f.layers).toHaveLength(0);
    expect(f.sources.size).toBe(0);
  });
  it("colours GPU instances and edge pieces by name and skips ones not loaded", () => {
    const f = chunkMap();
    addFieldChunk(f.map, "0", "blob:x", 17.5, { tri: true, hexa: true });
    const inst: unknown[][] = [];
    const lookup = (n: string) =>
      n === "T1" ? ({ kind: "clip", source: "fg-c-0", id: 7 } as const) : n === "T3" ? ({ kind: "inst", held: "B", i: 4 } as const) : null;
    paintLatticeColors(f.map, lookup, (h, i, c) => inst.push([h, i, c]), null, new Map([["T1", "#f00"], ["T2", "#0f0"], ["T3", "#00f"]]));
    expect(f.states).toEqual([["set", { source: "fg-c-0", id: 7 }, { c: "#f00" }]]);
    expect(inst).toEqual([["B", 4, "#00f"]]);
    paintLatticeColors(f.map, lookup, (h, i, c) => inst.push([h, i, c]), new Map([["T1", "#f00"], ["T3", "#00f"]]), new Map());
    expect(f.states.at(-1)).toEqual(["clear", { source: "fg-c-0", id: 7 }, "c"]);
    expect(inst.at(-1)).toEqual(["B", 4, null]);
  });
});
