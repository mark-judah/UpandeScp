import { describe, expect, it } from "vitest";
import {
  BucketIndex, buildGrid, classOf, idwField, inPoly, makeFrame, polysFromGeojson, polysNear,
  DEFAULT_CUTS, quantileCuts, renderRgba, samplesToGrid, summarizeByOwner,
} from "./idw";
import { buildHeatPoints, computeField, observationOptions } from "./pest-heat";

const frame = makeFrame(36, 0); // equator: ~111 km per degree both ways
const D = 1 / 111_320; // one metre in degrees
const sq = (x0: number, y0: number, w: number, h: number) => [
  [36 + x0 * D, y0 * D], [36 + (x0 + w) * D, y0 * D], [36 + (x0 + w) * D, (y0 + h) * D],
  [36 + x0 * D, (y0 + h) * D], [36 + x0 * D, y0 * D],
];
const fc = (features: any[]) => ({ features });

describe("polygons", () => {
  it("flattens Polygon and MultiPolygon with tags and honours holes", () => {
    const polys = polysFromGeojson(
      fc([
        { geometry: { type: "Polygon", coordinates: [sq(0, 0, 100, 100), sq(40, 40, 20, 20)] }, properties: { n: "A" } },
        { geometry: { type: "MultiPolygon", coordinates: [[sq(200, 0, 50, 50)], [sq(300, 0, 50, 50)]] }, properties: { n: "B" } },
      ]),
      (p) => p.n,
    );
    expect(polys.map((p) => p.tag)).toEqual(["A", "B", "B"]);
    expect(inPoly(36 + 10 * D, 10 * D, polys[0])).toBe(true);
    expect(inPoly(36 + 50 * D, 50 * D, polys[0])).toBe(false); // hole
    expect(inPoly(36 + 125 * D, 10 * D, polys[0])).toBe(false);
  });
});

describe("grid", () => {
  const polys = polysFromGeojson(
    fc([
      { geometry: { type: "MultiPolygon", coordinates: [[sq(0, 0, 100, 100)], [sq(200, 0, 100, 100)]] }, properties: { n: "A" } },
    ]),
    (p) => p.n,
  );
  it("clips to polygons (gap between parts stays outside)", () => {
    const g = buildGrid(polys, frame, 10)!;
    expect(g.cols).toBe(30);
    expect(g.rows).toBe(10);
    const inside = g.owner.filter((o) => o >= 0).length;
    expect(inside).toBe(200); // two 10x10 blocks of cells
    expect(g.owner[0 * g.cols + 15]).toBe(-1); // the gap
  });
  it("coarsens when over the cell budget", () => {
    const g = buildGrid(polys, frame, 1, 2000)!;
    expect(g.cols * g.rows).toBeLessThanOrEqual(2000);
    expect(g.cellM).toBeGreaterThan(1);
  });
  it("returns null with no polygons", () => expect(buildGrid([], frame)).toBeNull());
});

describe("BucketIndex", () => {
  it("matches a brute-force radius query", () => {
    const s = Array.from({ length: 500 }, (_, i) => ({ x: (i * 37) % 1000, y: (i * 91) % 1000, v: 1 }));
    const idx = new BucketIndex(s, 120);
    const got = idx.within(500, 500, 120).sort((a, b) => a - b);
    const want = s.map((p, i) => [p, i] as const).filter(([p]) => Math.hypot(p.x - 500, p.y - 500) <= 120).map(([, i]) => i);
    expect(got).toEqual(want);
  });
});

describe("idwField", () => {
  const polys = polysFromGeojson(fc([{ geometry: { type: "Polygon", coordinates: [sq(0, 0, 400, 100)] }, properties: { n: "A" } }]), () => "A");
  const grid = buildGrid(polys, frame, 10)!;
  const at = (g: typeof grid, x: number, y: number) => {
    const c = Math.floor(x / g.cellM), r = Math.floor((g.rows * g.cellM - y) / g.cellM);
    return r * g.cols + c;
  };
  it("a zero beside a hit pulls the field down; far cells stay unfilled", () => {
    const s = samplesToGrid(grid, [
      { lng: 36 + 5 * D, lat: 55 * D, v: 10 },
      { lng: 36 + 55 * D, lat: 50 * D, v: 0 },
    ]);
    const f = idwField(grid, s);
    const mid = f.value[at(grid, 30, 50)];
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(10);
    expect(f.value[at(grid, 5, 55)]).toBeCloseTo(10, 5); // exact hit
    expect(Number.isNaN(f.value[at(grid, 395, 50)])).toBe(true); // > 120 m away
    expect(f.dist[at(grid, 395, 50)]).toBe(Infinity);
    expect(f.dist[at(grid, 30, 50)]).toBeLessThan(40);
  });
  it("uses at most k=8 nearest and is a weighted mean within sample range", () => {
    const pts = Array.from({ length: 30 }, (_, i) => ({ lng: 36 + (10 + i * 3) * D, lat: 50 * D, v: i % 2 ? 4 : 0 }));
    const f = idwField(grid, samplesToGrid(grid, pts));
    for (const v of f.value) if (!Number.isNaN(v)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(4); }
  });
  it("matches a brute-force k-nearest IDW", () => {
    const pts = Array.from({ length: 300 }, (_, i) => ({ lng: 36 + ((i * 53) % 400) * D, lat: ((i * 29) % 100) * D, v: (i * 7) % 6 }));
    const smp = samplesToGrid(grid, pts);
    const f = idwField(grid, smp, { k: 8, power: 2, radiusM: 120 });
    for (const [x, y] of [[100, 40], [250, 70], [333, 12]]) {
      const i = at(grid, x, y);
      const cx = (Math.floor(x / grid.cellM) + 0.5) * grid.cellM, cy = grid.rows * grid.cellM - (Math.floor((grid.rows * grid.cellM - y) / grid.cellM) + 0.5) * grid.cellM;
      const near = smp.map((s) => ({ d: Math.hypot(s.x - cx, s.y - cy), v: s.v })).filter((s) => s.d <= 120).sort((a, b) => a.d - b.d).slice(0, 8);
      const w = near.map((s) => 1 / (s.d * s.d));
      const want = near.reduce((a, s, j) => a + s.v * w[j], 0) / w.reduce((a, b) => a + b, 0);
      expect(f.value[i]).toBeCloseTo(want, 3);
    }
  });
  it("no samples → everything unfilled", () => {
    expect(idwField(grid, []).value.every(Number.isNaN)).toBe(true);
  });
});

describe("bands and rendering", () => {
  it("quantile cuts ignore zeros and classify", () => {
    const c = quantileCuts([0, 0, 0, 1, 2, 3, 4, 5, 6]);
    expect(classOf(0, c)).toBe(0);
    expect(classOf(6, c)).toBe(2);
    expect(classOf(3, c)).toBe(1);
    expect(quantileCuts([0, 0]).high).toBe(Infinity);
    expect(classOf(5, quantileCuts([0, 0]))).toBe(0);
  });
  it("default cuts: amber from 1 in 5 trees, red from 1 in 2", () => {
    expect(classOf(0.1, DEFAULT_CUTS)).toBe(0);
    expect(classOf(0.3, DEFAULT_CUTS)).toBe(1);
    expect(classOf(0.5, DEFAULT_CUTS)).toBe(2);
  });
  it("fades with distance, hatches unfilled, leaves outside transparent; summarises per block", () => {
    const polys = polysFromGeojson(fc([{ geometry: { type: "Polygon", coordinates: [sq(0, 0, 100, 100)] }, properties: {} }]), () => "A");
    const grid = buildGrid(polys, frame, 10)!;
    const f = idwField(grid, samplesToGrid(grid, [{ lng: 36 + 5 * D, lat: 95 * D, v: 5 }]));
    const cuts = { mid: 1, high: 3 };
    const px = renderRgba(grid, f, cuts, ["#00ff00", "#ffff00", "#ff0000"]);
    expect(px[3]).toBeGreaterThan(px[(0 * grid.cols + 9) * 4 + 3] || 0); // near cell is more opaque than farther one
    const s = summarizeByOwner(grid, f, cuts)[0];
    expect(s.tag).toBe("A");
    expect(s.redShare).toBe(1);
    expect(s.coverage).toBeGreaterThan(0);
    expect(s.coverage).toBeLessThan(1);
  });
  it("polysNear drops blocks with no sample within reach", () => {
    const polys = polysFromGeojson(fc([
      { geometry: { type: "Polygon", coordinates: [sq(0, 0, 100, 100)] }, properties: {} },
      { geometry: { type: "Polygon", coordinates: [sq(5000, 0, 100, 100)] }, properties: {} },
    ]));
    expect(polysNear(polys, [{ lng: 36 + 50 * D, lat: 50 * D }], 120, frame)).toHaveLength(1);
  });
});

describe("pest-heat samples", () => {
  const e = (o: any) => ({ latitude: 0.001, longitude: 36.001, pests_scouting_entry: [], diseases_scouting_entry: [], trap_scouting_entry: [], ...o });
  const entries: any[] = [
    e({ pests_scouting_entry: [{ pest: "Fruit fly", count: 3 }, { pest: "Thrips", count: 0 }] }),
    e({ latitude: 0.002, pests_scouting_entry: [{ pest: "Thrips", count: 2 }] }), // fruit fly absent = 0
    e({ latitude: 0, longitude: 0, pests_scouting_entry: [{ pest: "Fruit fly", count: 9 }] }), // no coords
    e({ latitude: 0.003, trap_scouting_entry: [{ trap: "T1", pest: "Fruit fly", count: 20 }, { trap: "T1", pest: "Fruit fly", count: 10 }] }),
  ];
  it("ranks options by count; no-count rows still count as 1", () => {
    const o = observationOptions(entries);
    expect(o[0]).toMatchObject({ name: "Fruit fly", count: 12 });
  });
  it("zeros count, unlocated entries are dropped, fixed traps are samples", () => {
    const pts = buildHeatPoints(entries, { kind: "pest", name: "Fruit fly" }, { T1: { lat: 0.01, lng: 36.01 } as any });
    const field = pts.filter((p) => !p.trap).map((p) => p.v).sort();
    expect(field).toEqual([0, 0, 3]);
    expect(pts.find((p) => p.trap)).toMatchObject({ v: 15, lat: 0.01 });
  });
  it("traps without a fixed location are ignored; disease uses severity or 1", () => {
    expect(buildHeatPoints(entries, { kind: "pest", name: "Fruit fly" }, {}).some((p) => p.trap)).toBe(false);
    const d: any[] = [e({ diseases_scouting_entry: [{ disease: "Anthracnose" }] }), e({ latitude: 0.002, diseases_scouting_entry: [{ disease: "Anthracnose", severity_level: "3" }] })];
    expect(buildHeatPoints(d, { kind: "disease", name: "Anthracnose" }).map((p) => p.v).sort()).toEqual([1, 3]);
  });
});

describe("perf on a Lokitela-size extent", () => {
  it("fills ~600 ha from 8000 samples quickly", () => {
    const feats = [];
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 4; j++)
        feats.push({ geometry: { type: "Polygon", coordinates: [sq(i * 420, j * 600, 400, 580)] }, properties: { n: `B${i}${j}` } });
    const polys = polysFromGeojson(fc(feats), (p) => p.n);
    const pts = Array.from({ length: 8000 }, (_, i) => ({
      lng: 36 + ((i * 7919) % 2500) * D, lat: ((i * 104729) % 2400) * D, v: i % 5 === 0 ? 3 : 0,
    }));
    const t0 = performance.now();
    const grid = buildGrid(polys, frame, 10, 40_000)!;
    const t1 = performance.now();
    const f = idwField(grid, samplesToGrid(grid, pts));
    const t2 = performance.now();
    renderRgba(grid, f, quantileCuts(pts.map((p) => p.v)), ["#00ff00", "#ffff00", "#ff0000"]);
    const t3 = performance.now();
    console.log(`cells=${grid.cols * grid.rows} cell=${grid.cellM.toFixed(1)}m grid=${(t1 - t0).toFixed(1)}ms idw=${(t2 - t1).toFixed(1)}ms render=${(t3 - t2).toFixed(1)}ms`);
    expect(t3 - t0).toBeLessThan(1500);
  });
});

describe("coffee with no blocks keyed in", () => {
  const entries: any[] = [
    { latitude: 0.001, longitude: 36.001, pests_scouting_entry: [{ pest: "Antestia", count: 2 }], diseases_scouting_entry: [], trap_scouting_entry: [] },
  ];
  const colors: [string, string, string] = ["#00ff00", "#ffff00", "#ff0000"];
  it("reports no-blocks (no crash) when the block layer is empty or far away", () => {
    expect(computeField(entries, { kind: "pest", name: "Antestia" }, { features: [] }, {}, () => "", colors).kind).toBe("no-blocks");
    const far = { features: [{ geometry: { type: "Polygon", coordinates: [sq(9000, 0, 100, 100)] }, properties: {} }] };
    expect(computeField(entries, { kind: "pest", name: "Antestia" }, far, {}, () => "", colors).kind).toBe("no-blocks");
  });
  it("reports no-samples when nothing is geo-tagged", () => {
    expect(computeField([{ ...entries[0], latitude: 0, longitude: 0 }], { kind: "pest", name: "Antestia" }, { features: [] }, {}, () => "", colors).kind).toBe("no-samples");
  });
});
