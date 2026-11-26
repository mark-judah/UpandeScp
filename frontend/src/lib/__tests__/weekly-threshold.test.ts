import { describe, expect, it } from "vitest";
import { MEDIUM_SHARE, blockWeekly, weeklyClass } from "../weekly-threshold";

const obs = (observation: string, per_ha: number | null, threshold_per_ha: number, kind: "pest" | "disease" = "pest") =>
  ({ block: "B1", farm: "F", kind, observation, cumulative: 0, area_ha: 2, per_ha, threshold_per_ha, crossed_on: null, daily: [], scouts: [] });

describe("weeklyClass", () => {
  it("is high at the threshold, exactly where the server alert fires (>=)", () => {
    expect(weeklyClass(10, 10)).toBe(2);
    expect(weeklyClass(9.99, 10)).toBe(1);
  });
  it("is medium from half the threshold, none/low below", () => {
    expect(weeklyClass(10 * MEDIUM_SHARE, 10)).toBe(1);
    expect(weeklyClass(4.9, 10)).toBe(0);
  });
  it("has no class without a threshold or a figure", () => {
    expect(weeklyClass(5, 0)).toBeNull();
    expect(weeklyClass(null, 10)).toBeNull();
  });
});

describe("blockWeekly", () => {
  const round = { blocks: [{ block: "B1", farm: "F", area_ha: 2, scouted: true, observations: [obs("Thrips", 12, 10), obs("Mites", 6, 10), obs("Rust", 1, 0, "disease")] }] };
  it("takes the worst selected observation", () => {
    const m = blockWeekly(round, [{ kind: "pest", name: "Mites" }]);
    expect(m.get("B1")).toMatchObject({ cls: 1, observation: "Mites" });
    expect(blockWeekly(round, null).get("B1")).toMatchObject({ cls: 2, observation: "Thrips", perHa: 12 });
  });
  it("leaves a block with no configured threshold out", () => {
    expect(blockWeekly(round, [{ kind: "disease", name: "Rust" }]).size).toBe(0);
  });
});
