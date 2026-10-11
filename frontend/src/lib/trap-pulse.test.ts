import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SIZE, MIN_SIZE, PULSE_CAP, ZERO_SIZE,
  prefersReducedMotion, pulseLevel, pulsePhase, trapMarkerHtml, trapPulse,
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
