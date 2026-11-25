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
import { decodeTriads } from "@/lib/field-geo";
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
    addFieldLayers(f.map, decodeTriads(null), { type: "FeatureCollection", features: [] }, []);
    const z = (id: string) => f.layers.find((l) => l.id === id)?.minzoom;
    expect(z("fg-tri-fill")).toBe(15.5);
    expect(z("fg-tri-line")).toBe(18);
    expect(z("fg-hexa-line")).toBe(16.5);
    expect([TRI_ZOOM, TRI_LINE_ZOOM, HEXA_LINE_ZOOM]).toEqual([15.5, 18, 16.5]);
    expect(f.layers.some((l) => l.id === "fg-rows")).toBe(false);
    expect(FG_LAYERS).not.toContain("fg-rows");
    expect(f.sources.has("fg-rows")).toBe(false);
  });
  it("a block without triads draws no triangles", () => {
    const f = fakeMap();
    const set = decodeTriads({ q: 1e7, blocks: {} });
    addFieldLayers(f.map, set, { type: "FeatureCollection", features: [] }, []);
    expect((f.sources.get("fg-tri") as { data: { features: unknown[] } }).data.features).toHaveLength(0);
  });
  it("toggles triangles and Hexa lines independently", () => {
    const f = fakeMap();
    addFieldLayers(f.map, decodeTriads(null), { type: "FeatureCollection", features: [] }, []);
    setFieldVisibility(f.map, { tri: false, hexa: true });
    expect(f.vis.get("fg-tri-fill")).toBe("none");
    expect(f.vis.get("fg-tri-line")).toBe("none");
    expect(f.vis.get("fg-hexa-line")).toBe("visible");
  });
});
