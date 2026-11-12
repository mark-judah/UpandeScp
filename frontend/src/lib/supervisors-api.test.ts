import { describe, expect, it } from "vitest";
import {
  benchmarkOf, eventText, medianFor, median, minutesText, monthGroup, radarAxes, splitRanked, weekRate,
  type SupervisorEvent, type SupervisorMedians, type SupervisorRow,
} from "./supervisors-api";

const radar = { punctuality: 0.8, completion: 0.5, accountability: null, sync: 0.25, attendance: 0.9, pace: 1 };
const row = (o: Partial<SupervisorRow> = {}) =>
  ({
    employee: "E1", name: "Ann Kay", rank: 1, assigned: 10, completed: 5, completion_rate: 50, late: 3,
    on_time_pct: 80, accountability_pct: null, median_sync_min: 125, absence_rate: null,
    median_spray_min: 45, farm: "F1", radar, ...o,
  }) as SupervisorRow;

describe("minutesText", () => {
  it("reads minutes, hours and negatives", () => {
    expect(minutesText(null)).toBe("—");
    expect(minutesText(45)).toBe("45 min");
    expect(minutesText(130)).toBe("2 h 10 min");
    expect(minutesText(120)).toBe("2 h");
    expect(minutesText(-30)).toBe("−30 min");
  });
});

describe("median", () => {
  it("ignores missing values and averages the middle pair", () => {
    expect(median([null, 3, 1, 2, 4])).toBe(2.5);
    expect(median([null])).toBeNull();
  });
});

describe("list and benchmark shaping", () => {
  it("splits ranked from the rest", () => {
    const { ranked, unranked } = splitRanked([row(), row({ employee: "E2", rank: null })]);
    expect(ranked.map((r) => r.employee)).toEqual(["E1"]);
    expect(unranked.map((r) => r.employee)).toEqual(["E2"]);
  });

  it("finds the farm median by primary farm and orders the benchmark as the axes", () => {
    const m = [{ farm: "F2", radar: {} }, { farm: "F1", radar: { ...radar, pace: 0.5 } }] as unknown as SupervisorMedians[];
    const found = medianFor({ medians: m }, row());
    expect(found?.farm).toBe("F1");
    expect(benchmarkOf(found)).toEqual([0.8, 0.5, null, 0.25, 0.9, 0.5]);
    expect(benchmarkOf(null)).toEqual([null, null, null, null, null, null]);
    expect(medianFor({ medians: m }, null)).toBeNull();
  });

  it("builds the six radar axes with readouts, unknowns left null", () => {
    const axes = radarAxes(row());
    expect(axes.map((a) => a.key)).toEqual(["punctuality", "completion", "accountability", "sync", "attendance", "pace"]);
    expect(axes[2].value).toBeNull();
    expect(axes[3].readout).toBe("2 h 5 min to sync");
    expect(axes[4].readout).toBe("no check-in data");
    expect(axes[0].readout).toBe("80% on time · 3 late");
  });
});

describe("events and weeks", () => {
  const ev = (o: Partial<SupervisorEvent> = {}): SupervisorEvent => ({
    plan: "WO-1", greenhouse: "GH 1", farm: "F1", scheduled: "2026-11-03 08:00:00", started: "2026-11-03 16:00:00",
    outcome: "late", grade: "orange", completed: true, delay_min: 480, spray_min: 40, acted_by: [], flags: ["offline"], ...o,
  });

  it("describes a late plan with its grade and who scanned", () => {
    const t = eventText(ev());
    expect(t.label).toBe("GH 1 · Started late");
    expect(t.detail).toBe("8 h after plan · late grade orange · sprayed 40 min · nobody scanned · offline");
  });

  it("describes an early start by a named scanner", () => {
    const t = eventText(ev({ outcome: "on_time", grade: null, delay_min: -90, spray_min: null, flags: [], acted_by: ["Bo"] }));
    expect(t.detail).toBe("1 h 30 min early · scanned by Bo");
  });

  it("groups by month and rates weeks", () => {
    expect(monthGroup("2026-11-03 08:00:00")).toBe("November 2026");
    expect(monthGroup(null)).toBe("No date");
    expect(weekRate({ due: 4, on_time: 1 })).toBe(25);
    expect(weekRate({ due: 0, on_time: 0 })).toBeNull();
  });
});
