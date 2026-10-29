import { describe, expect, it } from "vitest";
import { MAX_SPHERE_M, MIN_SPHERE_M, sphereRadius, spherePoints, spherePulse } from "../sphere-data";
import type { ScoutingEntry } from "@/lib/scouting-types";

describe("sphereRadius", () => {
  it("grows with the value on a log scale, capped, and is zero for nothing", () => {
    expect(sphereRadius(0)).toBe(0);
    expect(sphereRadius(-3)).toBe(0);
    expect(sphereRadius(1)).toBeGreaterThanOrEqual(MIN_SPHERE_M);
    expect(sphereRadius(4)).toBeGreaterThan(sphereRadius(1));
    expect(sphereRadius(40)).toBeGreaterThan(sphereRadius(4));
    expect(sphereRadius(10_000)).toBe(MAX_SPHERE_M);
    expect(sphereRadius(Number.NaN)).toBe(0);
  });
});

describe("spherePoints", () => {
  const e = (name: string, unit: Partial<ScoutingEntry>, n: number, lat = 0.1, lng = 36.1) =>
    ({ name, ...unit, latitude: String(lat), longitude: String(lng), pests_scouting_entry: n ? [{ pest: "Thrips", count: n }] : [], diseases_scouting_entry: [] }) as unknown as ScoutingEntry;
  it("one sphere per unit at its worst visit, on the hexagon centre when known", () => {
    const pts = spherePoints(
      [e("a", { triad: "H1" }, 2), e("b", { triad: "H1" }, 9), e("c", { triad: "H2" }, 0), e("d", {}, 3, 0.2, 36.2)],
      { kind: "pest", name: "Thrips" },
      (k) => (k === "H1" ? [36.05, 0.05] : null),
    );
    expect(pts).toEqual([
      { key: "H1", lng: 36.05, lat: 0.05, value: 9 },
      { key: "pt:d", lng: 36.2, lat: 0.2, value: 3 },
    ]);
  });
});

describe("spherePulse", () => {
  it("breathes gently around 1 and stands still under reduced motion", () => {
    for (let t = 0; t < 5000; t += 250) {
      const s = spherePulse(t, 0.3, false);
      expect(s).toBeGreaterThan(0.9);
      expect(s).toBeLessThan(1.1);
    }
    expect(spherePulse(1234, 0.3, true)).toBe(1);
  });
});
