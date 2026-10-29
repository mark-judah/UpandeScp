import { describe, expect, it } from "vitest";
import { entryPoint, unitKey } from "../unit-key";
import type { ScoutingEntry } from "../scouting-types";

const e = (o: Partial<ScoutingEntry>) => ({ name: "SCE-1", ...o }) as ScoutingEntry;

describe("unitKey", () => {
  it("prefers the tree, then the triad", () => {
    expect(unitKey(e({ tree: "T1", triad: "H1" }))).toBe("T1");
    expect(unitKey(e({ triad: "H1", latitude: "0.04", longitude: "36.67" }))).toBe("H1");
  });
  it("falls back to the visit point when there is a real coordinate", () => {
    expect(unitKey(e({ latitude: "0.0412", longitude: "36.6712" }))).toBe("pt:SCE-1");
  });
  it("is empty with no coordinate, or the Atlantic", () => {
    expect(unitKey(e({}))).toBe("");
    expect(unitKey(e({ latitude: "", longitude: "" }))).toBe("");
    expect(unitKey(e({ latitude: "0", longitude: "0" }))).toBe("");
  });
  it("reads string or number coordinates as lng, lat", () => {
    expect(entryPoint(e({ latitude: -1.5, longitude: 36.5 }))).toEqual([36.5, -1.5]);
  });
});
