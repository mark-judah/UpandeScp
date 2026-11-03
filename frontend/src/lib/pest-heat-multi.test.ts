import { describe, expect, it } from "vitest";
const ALPHAS = { low: 0.2, mid: 0.4, high: 0.8, clean: 0.06 };
import { computeMultiField, rankBlocks } from "./pest-heat-multi";

const ring = (x0: number) => [[[x0, 0], [x0 + 0.001, 0], [x0 + 0.001, 0.001], [x0, 0.001], [x0, 0]]];
const BLOCKS = {
  features: ["A", "B"].map((b, i) => ({ geometry: { type: "Polygon", coordinates: ring(36 + i * 0.001) }, properties: { block: b } })),
};
const tag = (p: any) => p.block;
const e = (lng: number, pest?: [string, number], disease?: [string, string]) =>
  ({
    latitude: "0.0005", longitude: String(lng),
    pests_scouting_entry: pest ? [{ pest: pest[0], count: pest[1] }] : [],
    diseases_scouting_entry: disease ? [{ disease: disease[0], severity_level: disease[1] }] : [],
    trap_scouting_entry: [],
  }) as any;
// block A: thrips 3 per tree, block B: anthracnose severity 5
const ENTRIES = [e(36.0003, ["Thrips", 3]), e(36.0006, ["Thrips", 3]), e(36.0013, undefined, ["Anthracnose", "5"]), e(36.0016, undefined, ["Anthracnose", "5"])];
const OBS = [{ kind: "pest" as const, name: "Thrips" }, { kind: "disease" as const, name: "Anthracnose" }];
const color = (o: { kind: string }) => (o.kind === "pest" ? "#3366cc" : "#8b5cf6");

describe("computeMultiField", () => {
  it("colours each block by its own dominant selected observation, in that colour", () => {
    const r = computeMultiField(ENTRIES, OBS, BLOCKS, {}, tag, color, "#5a5a54", ALPHAS);
    if (r.kind !== "ok") throw new Error(r.kind);
    expect(r.dominant.get("A")).toBe("pest|Thrips");
    expect(r.dominant.get("B")).toBe("disease|Anthracnose");
    expect(r.share.size).toBe(2);
    // a pixel inside block A is the pest blue, one inside B the disease violet
    const px = (lng: number) => {
      const c = Math.floor((lng - r.grid.west) / ((r.grid.east - r.grid.west) / r.grid.cols));
      const row = Math.floor(r.grid.rows / 2);
      const o = (row * r.grid.cols + c) * 4;
      return [r.rgba[o], r.rgba[o + 1], r.rgba[o + 2]];
    };
    expect(px(36.0004)).toEqual([0x33, 0x66, 0xcc]);
    expect(px(36.0015)).toEqual([0x8b, 0x5c, 0xf6]);
  });

  it("ranks by the worst of the selected, not their sum, and follows the selection", () => {
    const both = computeMultiField(ENTRIES, OBS, BLOCKS, {}, tag, color, "#5a5a54", ALPHAS);
    if (both.kind !== "ok") throw new Error();
    expect(rankBlocks(both.blocks).map((b) => b.tag)).toEqual(["B", "A"]);
    const pestOnly = computeMultiField(ENTRIES, [OBS[0], { kind: "pest", name: "Mites" }], BLOCKS, {}, tag, color, "#5a5a54", ALPHAS);
    if (pestOnly.kind !== "ok") throw new Error();
    expect(rankBlocks(pestOnly.blocks)[0].tag).toBe("A");
  });

  it("reports no samples when nothing selected was located", () => {
    expect(computeMultiField([], OBS, BLOCKS, {}, tag, color, "#5a5a54", ALPHAS).kind).toBe("no-samples");
  });
});
