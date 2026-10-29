import { describe, expect, it } from "vitest";
import { decodeHexes, rowLines, triadName, type HexPayload } from "../field-geo";

const tpl = [[-233, -134], [1, -269], [234, -134], [234, 135], [1, 270], [-233, 135]];
const hex: HexPayload = {
  q: 1e7,
  tpl,
  blocks: [
    { b: "P1-B1 - MUT", reg: [1, 1, 366700000, 400000, 1, 2, 366701000, 400000], irr: [["P1-B1 - MUT - Row 2 - Triad 1", 2, 1, [367000000, 500000, 200, 0, 0, 300]]] },
  ],
};

describe("decodeHexes", () => {
  it("rebuilds regular hexagons from centre + shared template", () => {
    const s = decodeHexes(hex);
    expect(s.count).toBe(3);
    const f = s.fc.features[0];
    expect(f.geometry.coordinates[0]).toHaveLength(7);
    expect(f.geometry.coordinates[0][0]).toEqual([(366700000 - 233) / 1e7, (400000 - 134) / 1e7]);
    expect(f.geometry.coordinates[0][6]).toEqual(f.geometry.coordinates[0][0]);
  });
  it("names triads like the Triad records and indexes them by id", () => {
    const s = decodeHexes(hex);
    expect(s.idByName.get(triadName("P1-B1 - MUT", 1, 2))).toBe(1);
    expect(s.fc.features[1].id).toBe(1);
    expect(s.fc.features[1].properties.n).toBe("P1-B1 - MUT - Row 1 - Triad 2");
  });
  it("rebuilds explicit rings from deltas", () => {
    const f = decodeHexes(hex).fc.features[2];
    expect(f.geometry.coordinates[0]).toEqual([[36.7, 0.05], [36.70002, 0.05], [36.70002, 0.05003]]);
  });
  it("is empty for no payload", () => {
    expect(decodeHexes(null).count).toBe(0);
  });
});

describe("rowLines", () => {
  it("draws a row as its two endpoints", () => {
    const fc = rowLines([{ b: "B", r: 3, n: 40, a: [10000000, 20000000], z: [10001000, 20000000] }], 1e7);
    expect(fc.features[0].geometry.coordinates).toEqual([[1, 2], [1.0001, 2]]);
    expect(fc.features[0].properties.row).toBe(3);
  });
});
