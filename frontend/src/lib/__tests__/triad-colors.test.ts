import { describe, expect, it } from "vitest";
import { triadObsColors } from "../triad-colors";
import type { ScoutingEntry } from "../scouting-types";

const C: [string, string, string] = ["g", "a", "r"];
const e = (triad: string, pests: Array<[string, number]> = [], diseases: string[] = []) =>
  ({ name: triad, triad, pests_scouting_entry: pests.map(([pest, count]) => ({ pest, count })), diseases_scouting_entry: diseases.map((disease) => ({ disease })) }) as unknown as ScoutingEntry;

describe("triadObsColors", () => {
  it("colours a pest by the worst single visit", () => {
    const m = triadObsColors([e("H1", [["Thrips", 2]]), e("H1", [["Thrips", 12]]), e("H2", [["Thrips", 5]]), e("H3", [["Aphids", 40]])], { kind: "pest", name: "Thrips", count: 0 }, C);
    expect(m.get("H1")).toBe("r");
    expect(m.get("H2")).toBe("a");
    expect(m.get("H3")).toBe("g"); // scouted, no thrips: low
  });
  it("colours a disease by how many visits found it", () => {
    const m = triadObsColors([e("H1", [], ["Blight"]), e("H2", [], ["Blight"]), e("H2", [], ["Blight"]), e("H3")], { kind: "disease", name: "Blight", count: 0 }, C);
    expect(m.get("H1")).toBe("a");
    expect(m.get("H2")).toBe("r");
    expect(m.get("H3")).toBe("g");
  });
  it("ignores visits with no hexagon", () => {
    expect(triadObsColors([{ name: "x", pests_scouting_entry: [], diseases_scouting_entry: [] } as unknown as ScoutingEntry], null, C).size).toBe(0);
  });
});
