import { describe, it, expect } from "vitest";
import {
  buildMatrixIndex,
  buildSeries,
  cellStats,
  DEFAULT_MIN_SAMPLE,
  structuralUnitsForSelection,
} from "../aggregate";
import type { Selection, TrendsPayload } from "../trends-types";

const GH12: Selection = {
  kind: "station",
  farm: "Karen Farm",
  station: "GH 12",
  label: "GH 12",
};
const FARM: Selection = { kind: "farm", farm: "Karen Farm", label: "Karen Farm" };

/**
 * One week, one greenhouse. 800 zones exist, 200 were scouted, 100 had Thrips.
 *
 *   correct incidence = 100/200 = 50%
 *   old (broken)      = 100/800 = 12.5%
 */
function payload(over: Partial<TrendsPayload> = {}): TrendsPayload {
  return {
    options: { farmStations: {}, pests: {}, diseases: {}, stagesByObs: {} },
    vocab: {
      weeks: ["2026-W29"],
      stations: ["GH 12", "GH 13"],
      obs: ["pest:Thrips"],
      stages: [""],
    },
    byAny: [[0, 0, 120]],
    byKindName: [[0, 0, 0, 100]],
    byKindNameStage: [],
    scoutedByStation: [[0, 0, 200]],
    intensityByStation: [[0, 0, 0, 300]],
    stationsByFarm: { "Karen Farm": ["GH 12", "GH 13"] },
    unitsByStation: { "GH 12": 120 },
    allWeeks: ["2026-W29"],
    unitTotalsByStation: { "GH 12": 800, "GH 13": 400 },
    unitLabel: "zone",
    unitLabelPlural: "zones",
    ...over,
  };
}

describe("buildSeries — incidence over scouted units", () => {
  it("divides by units scouted, not by units that exist", () => {
    const p = payload();
    const series = buildSeries(
      p,
      buildMatrixIndex(p),
      [GH12],
      { kind: "pest", name: "Thrips", label: "Thrips" },
      null,
    );
    expect(series).toHaveLength(1);
    // 100/200, NOT 100/800 = 12.5 which is what the old denominator produced.
    expect(series[0]["GH 12"]).toBe(50);
    expect(series[0].date).toBe("2026-W29");
  });

  it("does not move when scouting effort changes at constant incidence", () => {
    // Same 50% incidence, half the scouting. The old formula halved the plotted
    // value here, which is the failure that made trend lines unreadable.
    const light = payload({
      byKindName: [[0, 0, 0, 50]],
      scoutedByStation: [[0, 0, 100]],
    });
    const heavy = payload();
    const obs = { kind: "pest" as const, name: "Thrips", label: "Thrips" };

    const a = buildSeries(light, buildMatrixIndex(light), [GH12], obs, null);
    const b = buildSeries(heavy, buildMatrixIndex(heavy), [GH12], obs, null);
    expect(a[0]["GH 12"]).toBe(50);
    expect(b[0]["GH 12"]).toBe(50);
  });

  it("sums the denominator across a farm selection", () => {
    const p = payload({
      byKindName: [
        [0, 0, 0, 100],
        [0, 1, 0, 20],
      ],
      scoutedByStation: [
        [0, 0, 200],
        [0, 1, 100],
      ],
    });
    const series = buildSeries(
      p,
      buildMatrixIndex(p),
      [FARM],
      { kind: "pest", name: "Thrips", label: "Thrips" },
      null,
    );
    // (100 + 20) / (200 + 100) = 40%
    expect(series[0]["Karen Farm"]).toBe(40);
  });

  it("never exceeds 100% — affected is a subset of scouted", () => {
    const p = payload({
      byKindName: [[0, 0, 0, 200]],
      scoutedByStation: [[0, 0, 200]],
    });
    const series = buildSeries(
      p,
      buildMatrixIndex(p),
      [GH12],
      { kind: "pest", name: "Thrips", label: "Thrips" },
      null,
    );
    expect(series[0]["GH 12"]).toBe(100);
  });

  it("suppresses a bucket whose sample is below the minimum", () => {
    // 2 of 3 zones = 67%, which would plot like a crisis.
    const p = payload({
      byKindName: [[0, 0, 0, 2]],
      scoutedByStation: [[0, 0, 3]],
    });
    const series = buildSeries(
      p,
      buildMatrixIndex(p),
      [GH12],
      { kind: "pest", name: "Thrips", label: "Thrips" },
      null,
    );
    expect(series[0]["GH 12"]).toBeNull();
  });

  it("honours a caller-supplied minimum sample", () => {
    const p = payload({
      byKindName: [[0, 0, 0, 2]],
      scoutedByStation: [[0, 0, 3]],
    });
    const obs = { kind: "pest" as const, name: "Thrips", label: "Thrips" };
    const series = buildSeries(p, buildMatrixIndex(p), [GH12], obs, null, 3);
    expect(series[0]["GH 12"]).toBeCloseTo(66.7, 1);
  });

  it("suppresses a week with no scouting at all rather than dividing by zero", () => {
    const p = payload({ scoutedByStation: [] });
    const series = buildSeries(
      p,
      buildMatrixIndex(p),
      [GH12],
      { kind: "pest", name: "Thrips", label: "Thrips" },
      null,
    );
    expect(series[0]["GH 12"]).toBeNull();
  });

  it("defaults the minimum sample to DEFAULT_MIN_SAMPLE", () => {
    const obs = { kind: "pest" as const, name: "Thrips", label: "Thrips" };
    const below = payload({
      byKindName: [[0, 0, 0, 1]],
      scoutedByStation: [[0, 0, DEFAULT_MIN_SAMPLE - 1]],
    });
    const at = payload({
      byKindName: [[0, 0, 0, 1]],
      scoutedByStation: [[0, 0, DEFAULT_MIN_SAMPLE]],
    });
    expect(buildSeries(below, buildMatrixIndex(below), [GH12], obs, null)[0]["GH 12"]).toBeNull();
    expect(buildSeries(at, buildMatrixIndex(at), [GH12], obs, null)[0]["GH 12"]).not.toBeNull();
  });
});

describe("cellStats — the audit numbers behind a point", () => {
  const p = payload();
  const index = buildMatrixIndex(p);
  const obs = { kind: "pest" as const, name: "Thrips", label: "Thrips" };

  it("reports affected, scouted and coverage separately", () => {
    const s = cellStats(p, index, GH12, "2026-W29", obs, null)!;
    expect(s.affected).toBe(100);
    expect(s.scouted).toBe(200);
    expect(s.structural).toBe(800);
    expect(s.coveragePct).toBe(25); // 200/800 — no longer folded into the %
    expect(s.suppressed).toBe(false);
  });

  it("derives pressure and severity from the intensity sum", () => {
    const s = cellStats(p, index, GH12, "2026-W29", obs, null)!;
    expect(s.intensitySum).toBe(300);
    expect(s.pressure).toBeCloseTo(1.5); // 300/200 per zone scouted
    expect(s.severity).toBeCloseTo(3.0); // 300/100 where present
  });

  it("satisfies pressure = incidence x severity", () => {
    const s = cellStats(p, index, GH12, "2026-W29", obs, null)!;
    const incidence = s.affected / s.scouted;
    expect(s.pressure!).toBeCloseTo(incidence * s.severity!);
  });

  it("reports no intensity for a disease", () => {
    const dp = payload({ vocab: { ...p.vocab, obs: ["disease:Powdery Mildew"] } });
    const s = cellStats(
      dp,
      buildMatrixIndex(dp),
      GH12,
      "2026-W29",
      { kind: "disease", name: "Powdery Mildew", label: "Powdery Mildew" },
      null,
    )!;
    expect(s.intensitySum).toBeNull();
    expect(s.pressure).toBeNull();
    expect(s.severity).toBeNull();
  });

  it("flags a suppressed bucket", () => {
    const small = payload({ scoutedByStation: [[0, 0, 4]] });
    const s = cellStats(small, buildMatrixIndex(small), GH12, "2026-W29", obs, null)!;
    expect(s.suppressed).toBe(true);
  });

  it("returns null coverage when the structural count is unknown", () => {
    const nostruct = payload({ unitTotalsByStation: {} });
    const s = cellStats(nostruct, buildMatrixIndex(nostruct), GH12, "2026-W29", obs, null)!;
    expect(s.coveragePct).toBeNull();
  });

  it("returns null for an unknown week", () => {
    expect(cellStats(p, index, GH12, "1999-W01", obs, null)).toBeNull();
  });
});

describe("structuralUnitsForSelection", () => {
  it("sums structural units across a farm's stations", () => {
    const p = payload();
    expect(structuralUnitsForSelection(FARM, p.stationsByFarm, p.unitTotalsByStation)).toBe(1200);
    expect(structuralUnitsForSelection(GH12, p.stationsByFarm, p.unitTotalsByStation)).toBe(800);
  });
});
