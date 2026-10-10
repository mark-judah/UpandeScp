import { describe, expect, it } from "vitest";
import { aggregateTraps, trapPosition } from "../TrapsMap";
import type { ScoutingEntry } from "@/lib/scouting-types";

const entry = (lat: number, lng: number, trap: string, count = 1) =>
  ({
    latitude: lat,
    longitude: lng,
    greenhouse: "GH 1 - KR",
    date_of_capture: "2026-10-01",
    trap_scouting_entry: [{ trap, count, pest: "FCM", location: "Indoor" }],
  }) as unknown as ScoutingEntry;

describe("trap placement", () => {
  it("draws a trap with a fixed location there, not at its entries' average", () => {
    const traps = aggregateTraps([entry(1, 2, "T1"), entry(3, 4, "T1")], {
      T1: { lat: 9, lng: 8, source: "GPS estimate", fixes: 6, spread_m: 4, flag: "" },
    });
    expect(trapPosition(traps[0])).toEqual({ lat: 9, lng: 8 });
  });

  it("falls back to the average of entry coordinates", () => {
    const traps = aggregateTraps([entry(1, 2, "T1"), entry(3, 4, "T1")]);
    expect(trapPosition(traps[0])).toEqual({ lat: 2, lng: 3 });
  });

  it("a fixed trap is placeable even with no entry coordinates", () => {
    const fixed = { T2: { lat: 1, lng: 1, source: "Manual" as const, fixes: 0, spread_m: 0, flag: "" } };
    expect(trapPosition(aggregateTraps([entry(0, 0, "T2")], fixed)[0])).toEqual({ lat: 1, lng: 1 });
    expect(trapPosition(aggregateTraps([entry(0, 0, "T2")])[0])).toBeNull();
  });
});
