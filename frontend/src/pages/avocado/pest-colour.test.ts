import { describe, expect, it } from "vitest";
import {
  SCALE_COLORS, UNSCOUTED_TONE, deriveMultiColors, deriveSingleColors, dominantPerUnit, levelFor, mix, scaleCuts,
} from "./pest-colour";

const e = (tree: string, pests: Array<[string, number]> = [], diseases: string[] = []) =>
  ({
    tree,
    pests_scouting_entry: pests.map(([pest, count]) => ({ pest, count })),
    diseases_scouting_entry: diseases.map((disease) => ({ disease })),
  }) as any;
const data = (entries: any[]) => ({ entries }) as any;
const col = (o: { name: string }) => ({ FCM: "#dc2626", Thrips: "#2563eb", Rust: "#c8a165" } as any)[o.name];

describe("multi-colour overview", () => {
  it("colours each tree by its dominant observation", () => {
    const d = data([e("t1", [["FCM", 5], ["Thrips", 2]]), e("t2", [["Thrips", 4]]), e("t3", [], ["Rust"])]);
    const dom = dominantPerUnit(d);
    expect(dom.get("t1")!.id).toBe("pest|FCM");
    expect(dom.get("t2")!.id).toBe("pest|Thrips");
    expect(dom.get("t3")!.id).toBe("disease|Rust");
  });
  it("fades a minor hit toward the unscouted tone, peak tree shows the full colour", () => {
    const d = data([e("t1", [["FCM", 10]]), e("t2", [["FCM", 1]])]);
    const m = deriveMultiColors(d, col);
    expect(m.get("t1")).toBe("#dc2626");
    expect(m.get("t2")).not.toBe("#dc2626");
    expect(m.get("t2")).toBe(mix("#dc2626", UNSCOUTED_TONE, dominantPerUnit(d).get("t2")!.intensity));
  });
});

describe("single pest scale", () => {
  it("uses thirds of the peak without a threshold", () => {
    const c = scaleCuts(9);
    expect([levelFor(1, c), levelFor(4, c), levelFor(9, c)]).toEqual([0, 1, 2]);
  });
  it("uses Count thresholds when set", () => {
    const c = scaleCuts(100, { measure: "Count", moderate: 5, high: 20, unit: "per tree" } as any);
    expect(c.fromThreshold).toBe(true);
    expect([levelFor(4, c), levelFor(5, c), levelFor(20, c)]).toEqual([0, 1, 2]);
  });
  it("ignores Percentage bands", () => {
    expect(scaleCuts(9, { measure: "Percentage", moderate: 5, high: 20, unit: "%" } as any).fromThreshold).toBe(false);
  });
  it("gives clean visited trees green and hot trees red", () => {
    const d = data([e("t1", [["FCM", 9]]), e("t2", [["Thrips", 3]]), e("t3", [["FCM", 1]])]);
    const m = deriveSingleColors(d, { kind: "pest", name: "FCM" });
    expect(m.get("t1")).toBe(SCALE_COLORS[2]);
    expect(m.get("t2")).toBe(SCALE_COLORS[0]);
    expect(m.get("t3")).toBe(SCALE_COLORS[0]);
  });
});
