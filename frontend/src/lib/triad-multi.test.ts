import { describe, expect, it } from "vitest";
import { multiUnitColors } from "./triad-multi";
import { toneOf } from "./pest-tone";

const e = (unit: string, pest?: [string, number], disease?: string) =>
  ({
    triad: unit,
    pests_scouting_entry: pest ? [{ pest: pest[0], count: pest[1] }] : [],
    diseases_scouting_entry: disease ? [{ disease }] : [],
  }) as any;
const T = { kind: "pest" as const, name: "Thrips", count: 1 };
const A = { kind: "disease" as const, name: "Anthracnose", count: 1 };
const col = (o: { kind: string }) => (o.kind === "pest" ? "#3366cc" : "#8b5cf6");
const key = (x: any) => x.triad;

describe("multiUnitColors", () => {
  it("each unit takes the colour of its worst selected observation at that band", () => {
    const m = multiUnitColors(
      [e("u1", ["Thrips", 12]), e("u1", undefined, "Anthracnose"), e("u2", ["Thrips", 2]), e("u2", undefined, "Anthracnose"), e("u3")],
      [T, A], col, key, "#5a5a54",
    );
    expect(m.get("u1")).toBe(toneOf("#3366cc", 2)); // thrips high beats a medium disease
    expect(m.get("u2")).toBe(toneOf("#8b5cf6", 1)); // disease medium beats thrips low
    expect(m.get("u3")).toBe(toneOf("#5a5a54", "clean")); // scouted and clean
  });
  it("ignores observations that are not selected", () => {
    const m = multiUnitColors([e("u1", ["Thrips", 12]), e("u1", undefined, "Anthracnose")], [A], col, key, "#5a5a54");
    expect(m.get("u1")).toBe(toneOf("#8b5cf6", 1));
  });
});
