import { describe, expect, it } from "vitest";
import { dewTiles, riskBands, slotMs, type DewHouse, type DewSlot } from "./dew-point-api";

const slot = (ts: string, risk: boolean): DewSlot => ({ ts, temp: 12, rh: 90, dew_point: 10, spread: risk ? 1 : 5, risk, sensors: 1 });

describe("riskBands", () => {
  it("merges consecutive at-risk slots and splits on a gap or a dry slot", () => {
    const bands = riskBands([
      slot("2026-11-12 01:00:00", true),
      slot("2026-11-12 01:30:00", true),
      slot("2026-11-12 02:00:00", false),
      slot("2026-11-12 02:30:00", true),
    ]);
    expect(bands).toEqual([
      { x1: slotMs("2026-11-12 01:00:00"), x2: slotMs("2026-11-12 02:00:00") },
      { x1: slotMs("2026-11-12 02:30:00"), x2: slotMs("2026-11-12 03:00:00") },
    ]);
  });
});

describe("dewTiles", () => {
  const house = (label: string, min: number | null, hours: number, now: boolean): DewHouse => ({
    greenhouse: label, farm: null, label, sensors: 1, sensors_reporting: 1, slots: [],
    summary: { min_spread: min, hours_at_risk: hours, latest_reading: null, latest_spread: null, at_risk_now: now },
  });
  it("counts houses at risk, sums hours, finds the lowest spread", () => {
    const t = dewTiles([house("A", 1.5, 2, true), house("B", 0.4, 1.5, false), house("C", null, 0, false)]);
    expect(t).toEqual({ atRiskNow: 1, total: 3, hoursAtRisk: 3.5, lowest: { spread: 0.4, label: "B" } });
  });
});
