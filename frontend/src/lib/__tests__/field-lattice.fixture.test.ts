/**
 * The exact-match check, browser side: the fixture is written by the server test
 * (upande_scp/serverscripts/tests/test_field_geo.py, TestExactMatch) from real Endebess blocks:
 * each block's lattice payload, the triangles hexa_grid.cut makes from the block outline, and
 * GPS points with the triad the server's scouting mapping (triad_in_block) gives them.
 */
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/field-lattice.json";
import { latticeCells, latticePick, latticeTriangles, triadName, type LatticeBlock } from "../field-geo";

const metres = (a: [number, number], b: number[]) =>
  Math.hypot((a[0] - b[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 110574);

type Fx = { tolerance_m: number; blocks: Record<string, { enc: LatticeBlock; cut: Record<string, number[][]>; points: Array<[number, number, string]> }> };
const fx = fixture as unknown as Fx;

describe("lattice decode matches hexa_grid.cut on real blocks", () => {
  for (const [block, b] of Object.entries(fx.blocks)) {
    it(`${block}: same triangles, hexa numbers and slots, every vertex within ${fx.tolerance_m} m`, () => {
      const tri = latticeTriangles(b.enc);
      expect([...tri.keys()].sort()).toEqual(Object.keys(b.cut).sort());
      let worst = 0;
      let clipped = 0;
      for (const [key, ring] of Object.entries(b.cut)) {
        const got = tri.get(key)!;
        expect(got.length).toBe(ring.length);
        if (ring.length !== 3) clipped++;
        got.forEach((p, i) => (worst = Math.max(worst, metres(p, ring[i]))));
      }
      expect(clipped).toBeGreaterThan(0);
      expect(worst).toBeLessThan(fx.tolerance_m);
    });
    it(`${block}: a point lands on the triad the scouting mapping gives it`, () => {
      const cells = latticeCells(b.enc);
      for (const [lng, lat, name] of b.points) {
        const hit = latticePick(b.enc, cells, lng, lat);
        expect(hit && triadName(block, hit.no, hit.t)).toBe(name);
      }
    });
  }
});
