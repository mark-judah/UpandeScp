import { describe, expect, it } from "vitest";
import {
  FarmLattice,
  chunkBlocks,
  edgePiecesGeojsonText,
  geometryBBox,
  latticeCells,
  latticePick,
  latticeToLngLat,
  latticeTriadSet,
  latticeTriangles,
  lngLatToLattice,
  tilesForBox,
  triadName,
  type LatticeBlock,
} from "../field-geo";

const R = 6378137;
const web = (lng: number, lat: number): [number, number] => [(lng * Math.PI * R) / 180, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R];
const [X0, Y0] = web(34.8, 1.06);
// Two hexas on row 0 (cols 0, 1) and one on row 1 (col 0, shifted half a width east).
// Hexa 1: all six full. Hexa 2: slots 1-3 kept, 1-2 full, 3 clipped. Hexa 3: slot 4 full.
const enc: LatticeBlock = {
  side: 5,
  aff: [1, 0, X0, 0, 1, Y0],
  h: [0, 0, 63 | (63 << 6), 0, 1, 7 | (3 << 6), 1, 0, 8 | (8 << 6)],
  e: [[1, 3, [0, 0, -100, 30, -100, -30]]], // a sliver of slot 3 (bearing 150..210)
  x: [],
};

describe("lattice decode", () => {
  it("places hexas on the cut() lattice and numbers them in order", () => {
    const c = latticeCells(enc);
    const w = Math.sqrt(3) * 5;
    expect([...c.x]).toEqual([0, w, w / 2]);
    expect([...c.y].map((v) => v + 0)).toEqual([0, 0, -7.5]);
    expect([...c.no]).toEqual([1, 2, 3]);
  });
  it("rebuilds slot t as [centre, V(30+60(t-1)), V(30+60t)] and clipped pieces from their ring", () => {
    const tri = latticeTriangles(enc);
    expect([...tri.keys()].sort()).toEqual(["1:1", "1:2", "1:3", "1:4", "1:5", "1:6", "2:1", "2:2", "2:3", "3:4"]);
    const [c, a, b] = tri.get("1:1")!.map(([lng, lat]) => lngLatToLattice(enc, lng, lat));
    expect(c[0]).toBeCloseTo(0, 6);
    expect(a[0]).toBeCloseTo(5 * Math.cos(Math.PI / 6), 6);
    expect(a[1]).toBeCloseTo(2.5, 6);
    expect(b[0]).toBeCloseTo(0, 6);
    expect(b[1]).toBeCloseTo(5, 6);
    const clip = tri.get("2:3")!.map(([lng, lat]) => lngLatToLattice(enc, lng, lat));
    expect(clip[1][0] - clip[0][0]).toBeCloseTo(-1, 6);
    expect(clip[1][1] - clip[0][1]).toBeCloseTo(0.3, 6);
  });
  it("round-trips lattice metres through lng/lat", () => {
    const [lng, lat] = latticeToLngLat(enc, 12.3, -45.6);
    const [x, y] = lngLatToLattice(enc, lng, lat);
    expect(x).toBeCloseTo(12.3, 6);
    expect(y).toBeCloseTo(-45.6, 6);
  });
});

describe("latticePick", () => {
  const cells = latticeCells(enc);
  const at = (x: number, y: number) => {
    const [lng, lat] = latticeToLngLat(enc, x, y);
    return latticePick(enc, cells, lng, lat);
  };
  it("finds the hexa by nearest centre and the slot by bearing", () => {
    expect(at(1, 2)).toEqual({ no: 1, t: 1 }); // bearing ~63deg: slot 1 (30..90)
    expect(at(-2, 0.1)).toEqual({ no: 1, t: 3 }); // ~177deg: slot 3 (150..210)
    expect(at(Math.sqrt(3) * 5 + 1, 2)).toEqual({ no: 2, t: 1 });
  });
  it("uses the clipped piece's polygon, and is null where nothing was kept", () => {
    const w = Math.sqrt(3) * 5;
    expect(at(w - 0.5, 0)).toEqual({ no: 2, t: 3 }); // inside the small clipped piece
    expect(at(w - 3, 0.5)).toBeNull(); // slot 3 of hexa 2, outside its piece
    expect(at(w, -2)).toBeNull(); // slot 5 of hexa 2: not kept
    expect(at(100, 100)).toBeNull();
  });
});

describe("FarmLattice", () => {
  it("resolves names to GPU instances and edge-piece ids, and picks by point", () => {
    const f = new FarmLattice();
    const held = f.add("B", enc, "fg-c-0");
    expect(f.lookup(triadName("B", 1, 1))).toEqual({ kind: "inst", held, i: 0 });
    expect(f.lookup(triadName("B", 2, 2))).toEqual({ kind: "inst", held, i: 7 });
    expect(f.lookup(triadName("B", 3, 4))).toEqual({ kind: "inst", held, i: 8 });
    expect(f.lookup(triadName("B", 2, 3))).toEqual({ kind: "clip", source: "fg-c-0", id: 0 });
    expect(f.lookup(triadName("B", 2, 5))).toBeNull();
    expect(f.lookup(triadName("C", 1, 1))).toBeNull();
    const [lng, lat] = latticeToLngLat(enc, 1, 2);
    expect(f.pick(lng, lat)).toBe(triadName("B", 1, 1));
    const fc = JSON.parse(edgePiecesGeojsonText([held]));
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].id).toBe(0);
    expect(fc.features[0].geometry.coordinates[0]).toHaveLength(4);
  });
  it("gives the gallery a feature per triangle", () => {
    const s = latticeTriadSet("B", enc);
    expect(s.count).toBe(10);
    expect(s.idByName.has(triadName("B", 3, 4))).toBe(true);
  });
});

describe("chunkBlocks", () => {
  const counts: Record<string, [number, number]> = { a: [8000, 1], b: [9000, 1], c: [40000, 1], d: [100, 1] };
  it("keeps the order and cuts before a chunk would pass the size; a big block is its own chunk", () => {
    expect(chunkBlocks(["a", "b", "c", "d"], counts, 20000)).toEqual([["a", "b"], ["c"], ["d"]]);
  });
});

describe("tilesForBox", () => {
  it("covers the box at the zoom", () => {
    expect(tilesForBox([0.1, 0.1, 0.2, 0.2], 1)).toEqual([[1, 0]]);
    expect(tilesForBox([-1, -1, 1, 1], 2)).toEqual([[1, 1], [1, 2], [2, 1], [2, 2]]);
  });
});

describe("geometryBBox", () => {
  it("spans every polygon of a MultiPolygon", () => {
    const g = { type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[4, 4], [5, 4], [5, 6], [4, 4]]]] };
    expect(geometryBBox(g)).toEqual([0, 0, 5, 6]);
    expect(geometryBBox(null)).toBeNull();
  });
});
