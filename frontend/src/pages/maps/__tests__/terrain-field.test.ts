import { describe, it, expect } from "vitest";
import {
  buildHeightField,
  peakAcross,
  playableWeeks,
  timeline,
  type ZonePoint,
} from "../terrain-field";

/** Value of the grid cell nearest a world position. */
function at(f: ReturnType<typeof buildHeightField>, x: number, y: number) {
  const cx = Math.round(((x - f.minX) / (f.maxX - f.minX || 1)) * (f.cols - 1));
  const cy = Math.round(((y - f.minY) / (f.maxY - f.minY || 1)) * (f.rows - 1));
  const i = cy * f.cols + cx;
  return { height: f.heights[i], confidence: f.confidence[i] };
}

describe("buildHeightField — unscouted ground never dips", () => {
  it("raises the gap between two peaks instead of dropping it to zero", () => {
    // Two measured peaks with nothing recorded between them. The middle must
    // rise toward its neighbours — "not scouted" is not "not there".
    const zones: ZonePoint[] = [
      { x: 0, y: 0, value: 10 },
      { x: 10, y: 0, value: 10 },
      { x: 0, y: 10, value: 10 },
      { x: 10, y: 10, value: 10 },
    ];
    const f = buildHeightField(zones, { resolution: 32 });
    const mid = at(f, 5, 5).height;
    expect(mid).toBeGreaterThan(1);
  });

  it("does not invent height above the surrounding measurements", () => {
    const zones: ZonePoint[] = [
      { x: 0, y: 0, value: 10 },
      { x: 10, y: 0, value: 10 },
      { x: 0, y: 10, value: 10 },
      { x: 10, y: 10, value: 10 },
    ];
    const f = buildHeightField(zones, { resolution: 32 });
    for (let i = 0; i < f.heights.length; i++) {
      expect(f.heights[i]).toBeLessThanOrEqual(10.001);
    }
  });

  it("an alternating odd/even sample produces a smooth surface, not a comb", () => {
    // Every other bed unscouted — what a single scouting session actually
    // looks like. The unscouted rows must not read as troughs.
    const zones: ZonePoint[] = [];
    for (let bed = 0; bed < 12; bed += 2) {
      for (let z = 0; z < 12; z++) zones.push({ x: bed, y: z, value: 8 });
    }
    const f = buildHeightField(zones, { resolution: 48 });
    const scouted = at(f, 4, 6).height;
    const skipped = at(f, 5, 6).height;
    // A comb would put the skipped bed near zero; it should sit close to its
    // scouted neighbours instead.
    expect(skipped).toBeGreaterThan(scouted * 0.6);
  });

  it("keeps a measured zero low while raising an unscouted neighbour", () => {
    // The distinction that has to survive: measured-zero is real information,
    // unmeasured is an estimate. Heights differ, and confidence separates them.
    const zones: ZonePoint[] = [
      { x: 0, y: 0, value: 0 },
      { x: 8, y: 0, value: 20 },
      { x: 8, y: 8, value: 20 },
      { x: 0, y: 8, value: 20 },
    ];
    const f = buildHeightField(zones, { resolution: 32, smoothPasses: 0 });
    const measuredZero = at(f, 0, 0);
    expect(measuredZero.height).toBeLessThan(1);
    expect(measuredZero.confidence).toBeCloseTo(1, 5);
  });
});

describe("buildHeightField — confidence marks estimate vs measurement", () => {
  const zones: ZonePoint[] = [
    { x: 0, y: 0, value: 5 },
    { x: 20, y: 20, value: 5 },
  ];
  const f = buildHeightField(zones, { resolution: 40, smoothPasses: 0 });

  it("is 1 where a real observation landed", () => {
    expect(at(f, 0, 0).confidence).toBeCloseTo(1, 5);
    expect(at(f, 20, 20).confidence).toBeCloseTo(1, 5);
  });

  it("falls off with distance from the nearest observation", () => {
    const near = at(f, 2, 2).confidence;
    const far = at(f, 10, 10).confidence;
    expect(near).toBeGreaterThan(far);
    expect(far).toBeLessThan(1);
  });

  it("stays within [0,1] everywhere", () => {
    for (let i = 0; i < f.confidence.length; i++) {
      expect(f.confidence[i]).toBeGreaterThanOrEqual(0);
      expect(f.confidence[i]).toBeLessThanOrEqual(1);
    }
  });
});

describe("buildHeightField — shape", () => {
  it("preserves aspect ratio so beds aren't squashed", () => {
    const zones: ZonePoint[] = [
      { x: 0, y: 0, value: 1 },
      { x: 100, y: 0, value: 1 },
      { x: 100, y: 25, value: 1 },
    ];
    const f = buildHeightField(zones, { resolution: 80 });
    expect(f.cols).toBe(80);
    expect(f.rows).toBe(20); // 80 * 25/100
  });

  it("averages several zones falling in one cell", () => {
    const f = buildHeightField(
      [
        { x: 0, y: 0, value: 4 },
        { x: 0, y: 0, value: 8 },
      ],
      { resolution: 4, fillPasses: 0, smoothPasses: 0 },
    );
    expect(at(f, 0, 0).height).toBeCloseTo(6);
  });

  it("returns an empty field for no zones rather than throwing", () => {
    const f = buildHeightField([]);
    expect(f.cols).toBe(0);
    expect(f.heights).toHaveLength(0);
  });
});

describe("peakAcross", () => {
  it("takes the max over every frame so the scale is shared", () => {
    // Per-week normalisation would make every week look equally bad; one scale
    // across the range is what makes the morph mean anything.
    const a = buildHeightField([{ x: 0, y: 0, value: 3 }], { resolution: 4 });
    const b = buildHeightField([{ x: 0, y: 0, value: 9 }], { resolution: 4 });
    expect(peakAcross([a, b])).toBeCloseTo(9, 5);
  });

  it("is 0 for no frames", () => {
    expect(peakAcross([])).toBe(0);
  });
});

describe("playback week selection", () => {
  const weeks = [
    { date: "2026-W27", complete: false },
    { date: "2026-W28", complete: true },
    { date: "2026-W29", complete: false },
    { date: "2026-W30", complete: true },
  ];

  it("skips incomplete weeks", () => {
    expect(playableWeeks(weeks).map((w) => w.date)).toEqual([
      "2026-W28",
      "2026-W30",
    ]);
  });

  it("treats an unflagged week as playable", () => {
    expect(playableWeeks([{ date: "2026-W28" }])).toHaveLength(1);
  });

  it("keeps skipped weeks in the timeline so gaps stay visible", () => {
    // A jump from W28 to W30 must read as a data gap, not two quiet weeks.
    const t = timeline(weeks);
    expect(t.map((e) => e.playable)).toEqual([false, true, false, true]);
    expect(t.map((e) => e.frame)).toEqual([null, 0, null, 1]);
    expect(t).toHaveLength(weeks.length);
  });
});
