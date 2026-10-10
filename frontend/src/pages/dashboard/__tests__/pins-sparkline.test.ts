import { describe, expect, it } from "vitest";
import { sparkSegments } from "../PinsPanel";

describe("sparkSegments", () => {
  it("splits at a null week so the line shows a gap", () => {
    const segs = sparkSegments([10, 20, null, 40, 50, 60]);
    expect(segs.map((s) => s.length)).toEqual([2, 3]);
  });
  it("keeps a lone point between gaps as its own one-point run", () => {
    expect(sparkSegments([null, 30, null, 10]).map((s) => s.length)).toEqual([1, 1]);
  });
  it("is empty when every week is thin", () => {
    expect(sparkSegments([null, null])).toEqual([]);
  });
});
