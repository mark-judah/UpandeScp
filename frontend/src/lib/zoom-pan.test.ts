import { describe, expect, it } from "vitest";
import { clampPan, clampZoom, fitScale, IDENTITY, panBy, toggleZoom, wheelFactor, zoomAt } from "@/lib/zoom-pan";

const size = { w: 400, h: 300 };

describe("zoom-pan", () => {
  it("clamps zoom to 0.5x..8x of fit", () => {
    expect(clampZoom(0.2)).toBe(0.5);
    expect(clampZoom(20)).toBe(8);
    expect(clampZoom(3)).toBe(3);
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(0.7)).toBe(0.7);
  });
  it("keeps the point under the cursor fixed", () => {
    const p = { x: 300, y: 100 };
    const v = zoomAt(IDENTITY, p, 2, size);
    // content point under p before: (300,100); after: (p - t) / s
    expect((p.x - v.x) / v.scale).toBeCloseTo(300);
    expect((p.y - v.y) / v.scale).toBeCloseTo(100);
  });
  it("never leaves a gap past an edge, and 1x re-centres", () => {
    expect(clampPan({ scale: 2, x: 50, y: 50 }, size)).toEqual({ scale: 2, x: 0, y: 0 });
    expect(clampPan({ scale: 2, x: -999, y: -999 }, size)).toEqual({ scale: 2, x: -400, y: -300 });
    expect(zoomAt({ scale: 4, x: -600, y: -400 }, { x: 10, y: 10 }, 1, size)).toEqual(IDENTITY);
  });
  it("fitScale is the object-contain scale", () => {
    expect(fitScale({ w: 4000, h: 3000 }, { w: 800, h: 600 })).toBeCloseTo(0.2);
    expect(fitScale({ w: 1000, h: 4000 }, { w: 800, h: 600 })).toBeCloseTo(0.15);
    expect(fitScale({ w: 100, h: 100 }, { w: 800, h: 600 })).toBe(6);
    expect(fitScale({ w: 0, h: 100 }, size)).toBe(0);
  });
  it("below fit the content stays centred and cannot be lost", () => {
    expect(clampPan({ scale: 0.5, x: 999, y: -999 }, size)).toEqual({ scale: 0.5, x: 100, y: 75 });
    const out = zoomAt(IDENTITY, { x: 0, y: 0 }, 0.1, size);
    expect(out).toEqual({ scale: 0.5, x: 100, y: 75 });
    expect(zoomAt(out, { x: 5, y: 5 }, 1, size)).toEqual(IDENTITY);
  });
  it("limits zoom to 8x", () => {
    expect(zoomAt(IDENTITY, { x: 0, y: 0 }, 50, size).scale).toBe(8);
  });
  it("pans within bounds", () => {
    const v = panBy({ scale: 2, x: 0, y: 0 }, -150, -999, size);
    expect(v).toEqual({ scale: 2, x: -150, y: -300 });
  });
  it("double-click toggles 1x and 2.5x", () => {
    const zoomed = toggleZoom(IDENTITY, { x: 200, y: 150 }, size);
    expect(zoomed.scale).toBe(2.5);
    expect(toggleZoom(zoomed, { x: 200, y: 150 }, size)).toEqual(IDENTITY);
  });
  it("wheel up zooms in, down zooms out", () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(-10, true)).toBeGreaterThan(wheelFactor(-10, false));
  });
});
