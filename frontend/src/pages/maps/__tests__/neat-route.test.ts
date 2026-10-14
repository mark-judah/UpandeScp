import { describe, expect, it } from "vitest";
import { bedNumber, neatRoute, routeEnd, zoneNumber, type BedGeometry, type RoutePing } from "../neat-route";

/** Beds of 10 zones laid along y: bed A at x=0, bed B at x=1, point(z)=[x,z]. */
const bed = (x: number, zoneCount = 10): BedGeometry => ({
  zoneCount,
  point: (z) => (z >= 1 && z <= zoneCount ? [x, z] : undefined),
});
const beds: Record<string, BedGeometry> = {
  "H - Bed 1": bed(0), "H - Bed 2": bed(1), "H - Bed 4": bed(3),
  "H - Bed 256": bed(10), "H - Bed 492": bed(20), "H - Bed 257": bed(10.1),
  A: bed(0), B: bed(1), C: bed(2),
};
const bedOf = (b: string) => beds[b];
const pings = (bedName: string, zs: number[]): RoutePing[] =>
  zs.map((zone) => ({ bed: bedName, zone }));
const flat = (s: { points: [number, number][] }[]) => s.flatMap((x) => x.points);

describe("zoneNumber", () => {
  it("reads the trailing zone number", () => {
    expect(zoneNumber("GH 11 - KR - Bed 3 - Zone 12")).toBe(12);
    expect(Number.isNaN(zoneNumber("no zone"))).toBe(true);
  });
});

describe("neatRoute", () => {
  it("rule 1: last ping on the last zone adds nothing", () => {
    const r = neatRoute(pings("A", [1, 5, 10]), bedOf);
    expect(r).toEqual([{ dashed: false, points: [[0, 1], [0, 5], [0, 10]] }]);
  });

  it("rule 1: last ping on the second-to-last zone runs on, solid, to the end zone", () => {
    const r = neatRoute(pings("A", [1, 5, 9]), bedOf);
    expect(r).toHaveLength(1);
    expect(r[0].dashed).toBe(false);
    expect(r[0].points.at(-1)).toEqual([0, 10]);
  });

  it("rule 2: first ping on the second zone starts, solid, at zone 1", () => {
    const r = neatRoute(pings("A", [2, 6, 10]), bedOf);
    expect(r).toHaveLength(1);
    expect(r[0].dashed).toBe(false);
    expect(r[0].points[0]).toEqual([0, 1]);
  });

  it("rule 3: a 2+ zone gap at the start is dotted up to the first real ping", () => {
    const r = neatRoute(pings("A", [3, 6, 10]), bedOf);
    expect(r[0]).toEqual({ dashed: true, points: [[0, 1], [0, 3]] });
    expect(r[1]).toEqual({ dashed: false, points: [[0, 3], [0, 6], [0, 10]] });
  });

  it("rule 3: a 2+ zone gap at the end is dotted from the last real ping", () => {
    const r = neatRoute(pings("A", [1, 4, 7]), bedOf);
    expect(r[0]).toEqual({ dashed: false, points: [[0, 1], [0, 4], [0, 7]] });
    expect(r[1]).toEqual({ dashed: true, points: [[0, 7], [0, 10]] });
  });

  it("works against the walking direction (descending bed)", () => {
    const r = neatRoute(pings("A", [9, 5, 2]), bedOf);
    expect(r).toHaveLength(1);
    expect(r[0].points[0]).toEqual([0, 10]);
    expect(r[0].points.at(-1)).toEqual([0, 1]);
    const d = neatRoute(pings("A", [8, 5, 3]), bedOf);
    expect(d[0]).toEqual({ dashed: true, points: [[0, 10], [0, 8]] });
    expect(d[1].dashed).toBe(false);
    expect(d[2]).toEqual({ dashed: true, points: [[0, 3], [0, 1]] });
  });

  it("joins beds in the scout's order: exit edge of one to entry edge of the next", () => {
    // A ascending ends at 9 (→ 10), B descending starts at 9 (→ 10), ends 2 (→ 1).
    const r = neatRoute([...pings("A", [1, 5, 9]), ...pings("B", [9, 5, 2])], bedOf);
    expect(r).toHaveLength(1);
    expect(flat(r)).toEqual([
      [0, 1], [0, 5], [0, 9], [0, 10], [1, 10], [1, 9], [1, 5], [1, 2], [1, 1],
    ]);
  });

  it("leaves a single-zone visit alone", () => {
    expect(neatRoute(pings("A", [4]), bedOf)).toEqual([]);
    const r = neatRoute([...pings("A", [4]), ...pings("B", [2, 8])], bedOf);
    expect(flat(r)[0]).toEqual([0, 4]);
  });

  it("collapses repeated zones and skips unknown beds", () => {
    const r = neatRoute([...pings("A", [1, 1, 5, 5, 10]), ...pings("Z", [1, 2])], bedOf);
    expect(flat(r)).toEqual([[0, 1], [0, 5], [0, 10]]);
  });

  it("routeEnd is the final point", () => {
    const r = neatRoute(pings("A", [1, 4, 7]), bedOf);
    expect(routeEnd(r)).toEqual([0, 10]);
    expect(routeEnd([], [3, 3])).toEqual([3, 3]);
  });
});

describe("neatRoute joins only neighbouring beds", () => {
  const b = (n: number) => `H - Bed ${n}`;
  it("reads bed numbers", () => {
    expect(bedNumber("Simotwo GH 20 - KR - Bed 256")).toBe(256);
    expect(Number.isNaN(bedNumber("nope"))).toBe(true);
  });

  it("joins beds whose numbers are within 2", () => {
    const r = neatRoute([...pings(b(1), [1, 5, 10]), ...pings(b(2), [10, 5, 1])], bedOf);
    expect(r).toHaveLength(1);
    const r2 = neatRoute([...pings(b(2), [1, 5, 10]), ...pings(b(4), [10, 5, 1])], bedOf);
    expect(r2).toHaveLength(1);
  });

  it("breaks the line on a far jump, keeping each bed's own end/start closure", () => {
    const r = neatRoute([...pings(b(256), [1, 5, 9]), ...pings(b(492), [2, 6, 10])], bedOf);
    expect(r).toHaveLength(2);
    expect(r[0].points).toEqual([[10, 1], [10, 5], [10, 9], [10, 10]]);
    expect(r[1].points).toEqual([[20, 1], [20, 2], [20, 6], [20, 10]]);
  });

  it("still joins a far-numbered bed when the exit is near the next entry", () => {
    const near = (a: [number, number], c: [number, number]) => Math.hypot(a[0] - c[0], a[1] - c[1]) < 12;
    const r = neatRoute([...pings(b(256), [1, 10]), ...pings(b(492), [10, 1])], bedOf, { near });
    expect(r).toHaveLength(1);
  });

  it("the route continues as separate pieces and ends at the last bed", () => {
    const r = neatRoute(
      [...pings(b(1), [1, 10]), ...pings(b(256), [1, 10]), ...pings(b(257), [10, 1]), ...pings(b(492), [4])],
      bedOf,
    );
    expect(r).toHaveLength(3);
    expect(routeEnd(r)).toEqual([20, 4]);
  });
});
