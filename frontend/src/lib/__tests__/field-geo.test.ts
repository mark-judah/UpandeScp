import { describe, expect, it } from "vitest";
import { decodeTriads, hexaEdges, triadName, type TriPayload } from "../field-geo";

const B = "P1-B1 - MUT";
const R = 450;
// Corner offsets of slot t (pointy-top hexagon, CCW from east, slot 1 = top-right), centre first.
const v = (k: number): [number, number] => [Math.round(R * Math.cos(((30 + 60 * k) * Math.PI) / 180)), Math.round(R * Math.sin(((30 + 60 * k) * Math.PI) / 180))];
const tpl: Record<string, Array<[number, number]>> = {};
for (let t = 1; t <= 6; t++) tpl[String(t)] = [[0, 0], v(t - 1), v(t)];

const X = 366700000;
const Y = 400000;
const reg: number[] = [];
for (let t = 1; t <= 6; t++) reg.push(1, t, X, Y);
const tri: TriPayload = {
  q: 1e7,
  blocks: { [B]: { tpl, reg, irr: [[2, 3, [367000000, 500000, 200, 0, 0, 300, -200, 0]]] } },
};

describe("decodeTriads", () => {
  it("rebuilds a full Hexa and a clipped piece (7 features)", () => {
    const s = decodeTriads(tri);
    expect(s.count).toBe(7);
    const ring = s.fc.features[0].geometry.coordinates[0];
    expect(ring).toHaveLength(4);
    expect(ring[0]).toEqual([X / 1e7, Y / 1e7]);
    expect(ring[1]).toEqual([(X + tpl["1"][1][0]) / 1e7, (Y + tpl["1"][1][1]) / 1e7]);
    expect(ring[3]).toEqual(ring[0]);
  });
  it("names triads like the Triad records, keeps props and indexes by id", () => {
    const s = decodeTriads(tri);
    expect(s.idByName.get(triadName(B, 1, 2))).toBe(1);
    expect(s.fc.features[1].properties).toEqual({ name: `${B} - Hexa 1 - Triad 2`, block: B, hexa: 1, t: 2 });
    expect(s.fc.features[6].properties.name).toBe(`${B} - Hexa 2 - Triad 3`);
  });
  it("rebuilds explicit rings from deltas", () => {
    expect(decodeTriads(tri).fc.features[6].geometry.coordinates[0]).toEqual([[36.7, 0.05], [36.70002, 0.05], [36.70002, 0.05003], [36.7, 0.05003]]);
  });
  it("uses an irregular piece's own name when carried", () => {
    const own: TriPayload = { q: 1e7, blocks: { [B]: { tpl: {}, reg: [], irr: [[null, null, [1, 1, 1, 0, 0, 1], "old - Row 4 - Triad 9"]] } } };
    expect(decodeTriads(own).idByName.has("old - Row 4 - Triad 9")).toBe(true);
  });
  it("is empty for no payload, and a block without triads draws no triangles", () => {
    expect(decodeTriads(null).count).toBe(0);
    expect(decodeTriads({ q: 1e7, blocks: {} }).count).toBe(0);
    expect(decodeTriads({ q: 1e7, blocks: { [B]: { tpl: {}, reg: [], irr: [] } } }).count).toBe(0);
  });
});

describe("hexaEdges", () => {
  it("gives 6 outer segments for a full Hexa", () => {
    const fc = hexaEdges(tri);
    expect(fc.features).toHaveLength(6);
    expect(fc.features[0].geometry.coordinates).toEqual([
      [(X + tpl["1"][1][0]) / 1e7, (Y + tpl["1"][1][1]) / 1e7],
      [(X + tpl["1"][2][0]) / 1e7, (Y + tpl["1"][2][1]) / 1e7],
    ]);
    expect(hexaEdges(null).features).toHaveLength(0);
  });
});
