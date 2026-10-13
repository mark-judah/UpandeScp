import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SIZE, MIN_SIZE, PULSE_CAP, ZERO_SIZE,
  polygonPoints, polygonSides, prefersReducedMotion, pulseLevel, pulsePhase, trapFocusZoom, trapMarkerHtml, trapPulse,
} from "./trap-pulse";

describe("trap pulse scaling", () => {
  it("a zero-count trap is a small static dot", () => {
    for (const c of [0, -3, NaN]) {
      expect(trapPulse(c)).toMatchObject({ size: ZERO_SIZE, pulse: false, scale: 1 });
    }
  });

  it("size and pulse reach grow with the count and beats quicken", () => {
    const counts = [1, 3, 10, 40, 120, PULSE_CAP];
    const ps = counts.map(trapPulse);
    for (let i = 1; i < ps.length; i++) {
      expect(ps[i].size).toBeGreaterThan(ps[i - 1].size);
      expect(ps[i].scale).toBeGreaterThan(ps[i - 1].scale);
      expect(ps[i].duration).toBeLessThan(ps[i - 1].duration);
    }
    expect(ps.every((p) => p.pulse)).toBe(true);
    expect(trapPulse(1).size).toBeGreaterThanOrEqual(MIN_SIZE);
  });

  it("is log-scaled and capped so huge counts do not swamp the map", () => {
    expect(trapPulse(PULSE_CAP)).toEqual(trapPulse(50_000));
    expect(trapPulse(50_000).size).toBe(MAX_SIZE);
    expect(trapPulse(50_000).scale).toBeLessThanOrEqual(2.4);
    // log: 10 catches is already well past a tenth of the way
    expect(pulseLevel(10)).toBeGreaterThan(0.4);
    expect(pulseLevel(PULSE_CAP * 10)).toBe(1);
  });

  it("phases are stable per trap and spread across traps", () => {
    expect(pulsePhase("KR - T1")).toBe(pulsePhase("KR - T1"));
    const phases = new Set(Array.from({ length: 50 }, (_, i) => pulsePhase(`KR - T${i}`)));
    expect(phases.size).toBeGreaterThan(40);
    for (const p of phases) expect(p >= 0 && p < 1).toBe(true);
  });
});

describe("trap marker html", () => {
  const base = { key: "T1", fill: "rgba(1,1,1,.3)", stroke: "rgba(1,1,1,.8)" };
  it("a counted trap carries a ring animated by its own scale and period", () => {
    const html = trapMarkerHtml({ ...base, count: 40, reducedMotion: false });
    const p = trapPulse(40);
    expect(html).toContain("scp-trap-ring");
    expect(html).toContain(`--trap-pulse-scale:${p.scale}`);
    expect(html).toContain(`--trap-pulse-dur:${p.duration}s`);
    expect(html).toContain(`width:${p.size}px`);
  });
  it("no ring for a zero-count trap or under reduced motion", () => {
    expect(trapMarkerHtml({ ...base, count: 0, reducedMotion: false })).not.toContain("scp-trap-ring");
    expect(trapMarkerHtml({ ...base, count: 400, reducedMotion: true })).not.toContain("scp-trap-ring");
    expect(trapMarkerHtml({ ...base, count: 400, reducedMotion: true })).toContain("scp-trap-core");
  });
});

describe("prefers-reduced-motion", () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });
  it("reads the media query", () => {
    window.matchMedia = vi.fn((q: string) => ({ matches: q.includes("reduce") }) as MediaQueryList);
    expect(prefersReducedMotion()).toBe(true);
    window.matchMedia = vi.fn(() => ({ matches: false }) as unknown as MediaQueryList);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("polygon markers", () => {
  it("sides = twice the highest single catch, clamped to 3–20", () => {
    expect(polygonSides(1)).toBe(3); // 2 → min 3: triangle
    expect(polygonSides(2)).toBe(4);
    expect(polygonSides(3)).toBe(6);
    expect(polygonSides(10)).toBe(20);
    expect(polygonSides(500)).toBe(20);
    expect(polygonSides(0)).toBe(3);
    expect(polygonSides(NaN)).toBe(3);
  });
  it("draws n vertices on the circle, first at the top; 4 sides is a diamond", () => {
    const pts = (n: number, size: number) =>
      polygonPoints(n, size).split(" ").map((p) => p.split(",").map(Number));
    expect(pts(6, 20)).toHaveLength(6);
    expect(pts(20, 20)).toHaveLength(20);
    const d = pts(4, 20); // r = 9, centre 10
    expect(d[0]).toEqual([10, 1]);
    expect(d[1][0]).toBeCloseTo(19, 1); expect(d[1][1]).toBeCloseTo(10, 1);
    expect(d[2][0]).toBeCloseTo(10, 1); expect(d[2][1]).toBeCloseTo(19, 1);
    for (const [x, y] of pts(7, 30)) expect(Math.hypot(x - 15, y - 15)).toBeCloseTo(14, 1);
  });
  it("markers carry a polygon with the right sides; zero stays a circle", () => {
    const base = { key: "T1", fill: "red", stroke: "blue", reducedMotion: false };
    const html = trapMarkerHtml({ ...base, count: 30, maxCount: 3 });
    const pts = /<polygon points="([^"]+)"/.exec(html)![1];
    expect(pts.split(" ")).toHaveLength(6);
    expect((html.match(/<polygon/g) || []).length).toBe(2); // core + ring
    const zero = trapMarkerHtml({ ...base, count: 0, maxCount: 0 });
    expect(zero).toContain("<circle");
    expect(zero).not.toContain("<polygon");
  });
  it("focusing a trap never zooms out", () => {
    expect(trapFocusZoom(14, 22)).toBe(19);
    expect(trapFocusZoom(21, 22)).toBe(21);
    expect(trapFocusZoom(21, 20)).toBe(20);
    expect(trapFocusZoom(10)).toBe(19);
  });
});
