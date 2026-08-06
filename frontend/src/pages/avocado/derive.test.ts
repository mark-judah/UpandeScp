import { describe, it, expect } from "vitest";
import type { ProcessedData } from "@/lib/scouting-types";
import { deriveScoutColors, deriveScoutRoster, SCOUT_PALETTE } from "./derive-scouts";
import { deriveObservationColors, deriveObservationRoster } from "./derive-observations";
import { deriveTrapMarkers, severityColor } from "./derive-traps";

function data(entries: any[]): ProcessedData {
  return { entries } as ProcessedData;
}

describe("deriveScoutColors", () => {
  it("tints each visited tree by its scout, palette in first-seen order", () => {
    const d = data([
      { tree: "T1", scouts_name: "A" },
      { tree: "T2", scouts_name: "B" },
      { tree: "T3", scouts_name: "A" },
    ]);
    const m = deriveScoutColors(d);
    expect(m.get("T1")).toBe(SCOUT_PALETTE[0]);
    expect(m.get("T3")).toBe(SCOUT_PALETTE[0]);
    expect(m.get("T2")).toBe(SCOUT_PALETTE[1]);
  });
  it("skips entries without a tree or scout", () => {
    expect(deriveScoutColors(data([{ scouts_name: "A" }, { tree: "T1" }])).size).toBe(0);
  });
  it("rosters scouts by distinct trees, most active first", () => {
    const r = deriveScoutRoster(data([
      { tree: "T1", scouts_name: "A" }, { tree: "T2", scouts_name: "A" }, { tree: "T3", scouts_name: "B" },
    ]));
    expect(r.map((x) => x.key)).toEqual(["A", "B"]);
    expect(r[0].trees).toBe(2);
  });
});

describe("deriveObservationColors", () => {
  const colorOf = (n: string) => (n === "Thrips" ? "#111111" : "#222222");
  it("tints a tree by its dominant pest of the active kind", () => {
    const d = data([
      { tree: "T1", pests_scouting_entry: [{ pest: "Thrips", count: 5 }, { pest: "Mites", count: 1 }], diseases_scouting_entry: [] },
    ]);
    expect(deriveObservationColors(d, "pest", colorOf).get("T1")).toBe("#111111");
  });
  it("honours kind — diseases ignored under pest kind", () => {
    const d = data([{ tree: "T1", pests_scouting_entry: [], diseases_scouting_entry: [{ disease: "Anthracnose" }] }]);
    expect(deriveObservationColors(d, "pest", colorOf).size).toBe(0);
    expect(deriveObservationColors(d, "disease", colorOf).get("T1")).toBe("#222222");
  });
  it("rosters observations by total count, most frequent first", () => {
    const d = data([
      { tree: "T1", pests_scouting_entry: [{ pest: "Thrips", count: 2 }], diseases_scouting_entry: [] },
      { tree: "T2", pests_scouting_entry: [{ pest: "Thrips", count: 3 }, { pest: "Mites", count: 1 }], diseases_scouting_entry: [] },
    ]);
    const r = deriveObservationRoster(d, "pest");
    expect(r.map((x) => x.name)).toEqual(["Thrips", "Mites"]);
    expect(r[0].count).toBe(5);
  });
});

describe("deriveTrapMarkers", () => {
  it("aggregates catches per trap at the averaged coordinate, sorted by count", () => {
    const d = data([
      { latitude: 1, longitude: 2, trap_scouting_entry: [{ trap: "TR1", count: 3 }] },
      { latitude: 1.0, longitude: 2.0, trap_scouting_entry: [{ trap: "TR1", count: 7 }] },
      { latitude: 5, longitude: 6, trap_scouting_entry: [{ trap: "TR2", count: 1 }] },
    ]);
    const m = deriveTrapMarkers(d);
    expect(m[0]).toMatchObject({ label: "TR1", count: 10, lng: 2, lat: 1 });
    expect(m[1]).toMatchObject({ label: "TR2", count: 1 });
    expect(m[0].color).toBe(severityColor(10));
  });
  it("drops trap catches with no usable coordinate", () => {
    const d = data([{ latitude: 0, longitude: 0, trap_scouting_entry: [{ trap: "TR1", count: 3 }] }]);
    expect(deriveTrapMarkers(d)).toEqual([]);
  });
  it("severityColor ramps by catch count", () => {
    expect(severityColor(0)).toBe("#e5e7eb");
    expect(severityColor(3)).toBe("#fde68a");
    expect(severityColor(60)).toBe("#f97316");
    expect(severityColor(1000)).toBe("#7c2d12");
  });

  it("counts only located catches for a trap (coord-less catch dropped)", () => {
    const d = data([
      { latitude: 1, longitude: 2, trap_scouting_entry: [{ trap: "TR1", count: 3 }] },
      { latitude: 0, longitude: 0, trap_scouting_entry: [{ trap: "TR1", count: 7 }] },
    ]);
    const m = deriveTrapMarkers(d);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ label: "TR1", count: 3, lng: 2, lat: 1 });
  });
});
