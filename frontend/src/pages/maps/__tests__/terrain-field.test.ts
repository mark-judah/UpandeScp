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

  it("keeps partial weeks — the interpolation already smooths them", () => {
    // Deliberately reversed: partial weeks used to be excluded, which threw
    // away 101 of 229 greenhouse-weeks. The surface flows smoothly across beds
    // a session skipped, so there is no trough to hide from; the week is shown
    // with its sample size instead.
    expect(playableWeeks(weeks).map((w) => w.date)).toEqual([
      "2026-W27",
      "2026-W28",
      "2026-W29",
      "2026-W30",
    ]);
  });

  it("treats an unflagged week as playable", () => {
    expect(playableWeeks([{ date: "2026-W28" }])).toHaveLength(1);
  });

  it("gives every week a frame, and keeps them in order", () => {
    const t = timeline(weeks);
    expect(t).toHaveLength(weeks.length);
    expect(t.map((e) => e.playable)).toEqual([true, true, true, true]);
    expect(t.map((e) => e.frame)).toEqual([0, 1, 2, 3]);
  });

  it("carries the sample size through, so partial weeks can be labelled", () => {
    const sized = [
      { date: "2026-W28", complete: true, bedsScouted: 29, zonesScouted: 43 },
      { date: "2026-W29", complete: false, bedsScouted: 54, zonesScouted: 183 },
    ];
    expect(playableWeeks(sized).map((w) => w.bedsScouted)).toEqual([29, 54]);
  });
});

describe("weightPaintColor — Blender-style weight ramp", () => {
  it("hits the canonical stops", async () => {
    const { weightPaintColor } = await import("../terrain-field");
    expect(weightPaintColor(0)).toEqual({ r: 0, g: 0, b: 1 }); // blue
    expect(weightPaintColor(0.25)).toEqual({ r: 0, g: 1, b: 1 }); // cyan
    expect(weightPaintColor(0.5)).toEqual({ r: 0, g: 1, b: 0 }); // green
    expect(weightPaintColor(0.75)).toEqual({ r: 1, g: 1, b: 0 }); // yellow
    expect(weightPaintColor(1)).toEqual({ r: 1, g: 0, b: 0 }); // red
  });

  it("interpolates between stops", async () => {
    const { weightPaintColor } = await import("../terrain-field");
    const mid = weightPaintColor(0.125); // halfway blue → cyan
    expect(mid.g).toBeCloseTo(0.5, 5);
    expect(mid.b).toBeCloseTo(1, 5);
  });

  it("clamps out-of-range so an overshoot can't wrap back to blue", async () => {
    const { weightPaintColor } = await import("../terrain-field");
    expect(weightPaintColor(1.4)).toEqual({ r: 1, g: 0, b: 0 });
    expect(weightPaintColor(-2)).toEqual({ r: 0, g: 0, b: 1 });
    expect(weightPaintColor(NaN)).toEqual({ r: 0, g: 0, b: 1 });
  });

  it("produces a legend that starts blue and ends red", async () => {
    const { weightPaintLegend } = await import("../terrain-field");
    const l = weightPaintLegend(5);
    expect(l).toHaveLength(5);
    expect(l[0].css).toBe("rgb(0,0,255)");
    expect(l[4].css).toBe("rgb(255,0,0)");
  });
});

describe("buildLattice — bed × zone index space", () => {
  const gh = "Torongo GH 07 - KR";
  const z = (bed: number, zone: number, value: number) => ({
    name: `${gh} - Bed ${bed} - Zone ${zone}`,
    value,
  });

  it("parses the bed number after 'Bed', never the greenhouse's digits", async () => {
    const { parseBedZone } = await import("../terrain-field");
    expect(parseBedZone("Torongo GH 07 - KR - Bed 51 - Zone 9")).toEqual({
      bed: 51,
      zone: 9,
    });
    expect(parseBedZone("Torongo GH 07 - KR")).toBeNull();
  });

  it("gives contiguous axes from 1 to the maximum, not just observed beds", async () => {
    const { buildLattice } = await import("../terrain-field");
    // Only beds 1 and 5 seen — the axis must still run 1..5 so a bed keeps its
    // position between weeks and the morph doesn't slide.
    const l = buildLattice([z(1, 1, 4), z(5, 3, 8)]);
    expect(l.bedNumbers).toEqual([1, 2, 3, 4, 5]);
    expect(l.zoneNumbers).toEqual([1, 2, 3]);
    expect(l.rows).toBe(5);
    expect(l.cols).toBe(3);
  });

  it("maps a cell back to its bed and zone for the tooltip", async () => {
    const { buildLattice, latticeCellAt } = await import("../terrain-field");
    const l = buildLattice([z(1, 1, 4), z(3, 2, 9)], { smoothPasses: 0 });
    const cell = latticeCellAt(l, 1, 2); // col=zone 2, row=bed 3
    expect(cell?.bed).toBe(3);
    expect(cell?.zone).toBe(2);
    expect(cell?.value).toBeCloseTo(9);
    expect(cell?.measured).toBe(true);
  });

  it("marks an interpolated cell as not measured", async () => {
    const { buildLattice, latticeCellAt } = await import("../terrain-field");
    const l = buildLattice([z(1, 1, 10), z(3, 1, 10)], { smoothPasses: 0 });
    const gap = latticeCellAt(l, 0, 1); // bed 2, never scouted
    expect(gap?.measured).toBe(false);
    // ...and it rises to its neighbours rather than cutting a trough.
    expect(gap!.value).toBeGreaterThan(1);
  });

  it("smooths odd/even bed alternation — the real scouting pattern", async () => {
    const { buildLattice, latticeCellAt } = await import("../terrain-field");
    const entries = [];
    for (let bed = 1; bed <= 11; bed += 2)
      for (let zone = 1; zone <= 6; zone++) entries.push(z(bed, zone, 8));
    const l = buildLattice(entries);
    const scouted = latticeCellAt(l, 2, 4)!.value; // bed 5
    const skipped = latticeCellAt(l, 2, 5)!.value; // bed 6, unscouted
    expect(skipped).toBeGreaterThan(scouted * 0.7);
  });

  it("returns an empty lattice for unparseable names rather than throwing", async () => {
    const { buildLattice } = await import("../terrain-field");
    const l = buildLattice([{ name: "no bed or zone here", value: 5 }]);
    expect(l.rows).toBe(0);
    expect(l.bedNumbers).toEqual([]);
  });
});

describe("buildGroundLattice — real ground shape, identity preserved", () => {
  const gh = "Torongo GH 07 - KR";
  const nm = (bed: number, zone: number) => `${gh} - Bed ${bed} - Zone ${zone}`;

  it("keeps bed identity per cell, so a U-shaped numbering still resolves", async () => {
    const { buildGroundLattice, latticeCellAt } = await import("../terrain-field");
    // Bed 10 physically adjacent to bed 140 — the U-shape case that bed-order
    // layout deliberately cannot represent.
    const positions = {
      [nm(10, 1)]: { x: 0, y: 0 },
      [nm(140, 1)]: { x: 1, y: 0 },
    };
    const l = buildGroundLattice(
      [
        { name: nm(10, 1), value: 5 },
        { name: nm(140, 1), value: 20 },
      ],
      positions,
      { resolution: 8 },
    );
    expect(l.identity).toBe("cell");
    const left = latticeCellAt(l, 0, 0);
    const right = latticeCellAt(l, l.cols - 1, 0);
    expect(left?.bed).toBe(10);
    expect(right?.bed).toBe(140);
  });

  it("bed-order layout tags identity as axis-indexed", async () => {
    const { buildLattice } = await import("../terrain-field");
    expect(buildLattice([{ name: nm(1, 1), value: 1 }]).identity).toBe("axis");
  });

  it("returns an empty lattice when no zone has a position", async () => {
    const { buildGroundLattice } = await import("../terrain-field");
    const l = buildGroundLattice([{ name: nm(1, 1), value: 5 }], {}, {});
    expect(l.cols).toBe(0);
    expect(l.identity).toBe("cell");
  });
});
