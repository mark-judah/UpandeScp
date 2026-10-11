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

describe("latest reading per trap", () => {
  it("keeps the newest reading's scout, time, count and pest", () => {
    const e = (date: string, time: string, scout: string, count: number) =>
      ({ ...entry(1, 2, "T1", count), date_of_capture: date, time_of_capture: time, scouts_name: scout }) as ScoutingEntry;
    const [t] = aggregateTraps([e("2026-10-01", "08:00:00", "A", 5), e("2026-10-02", "07:30:00.000", "B", 2), e("2026-10-02", "06:00:00", "C", 9)]);
    expect(t.latest).toEqual({ date: "2026-10-02", time: "07:30:00", scout: "B", count: 2, pest: "FCM" });
  });
});
