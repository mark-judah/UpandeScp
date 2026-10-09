import { describe, expect, it } from "vitest";
import {
  BAND_SUFFIX,
  buildMarginBands,
  buildMatrixIndex,
  buildPrevalenceByWeek,
  buildPrevalenceIndex,
  lineConnectsNulls,
  overlayPrevalence,
  prevalenceForCell,
} from "../aggregate";
import type { ObsKey, Selection, TrendsPayload } from "../trends-types";

const GH12: Selection = { kind: "station", farm: "Karen Farm", station: "GH 12", label: "GH 12" };
const FARM: Selection = { kind: "farm", farm: "Karen Farm", label: "Karen Farm" };
const THRIPS: ObsKey = { kind: "pest", name: "Thrips", label: "Thrips" };

function payload(over: Partial<TrendsPayload> = {}): TrendsPayload {
  return {
    options: { farmStations: {}, pests: {}, diseases: {}, stagesByObs: {} },
    vocab: {
      weeks: ["2031-W10"], stations: ["GH 12", "GH 13"], obs: ["pest:Thrips"], stages: [""],
      farms: ["Karen Farm"], reliability: ["Good", "Fair", "Low"],
    },
    byAny: [[0, 0, 9]],
    byKindName: [[0, 0, 0, 9]],
    byKindNameStage: [],
    scoutedByStation: [[0, 0, 27]],
    intensityByStation: [],
    stationsByFarm: { "Karen Farm": ["GH 12", "GH 13"] },
    unitsByStation: { "GH 12": 27 },
    allWeeks: ["2031-W10"],
    unitTotalsByStation: { "GH 12": 666, "GH 13": 500 },
    unitLabel: "zone",
    unitLabelPlural: "zones",
    prevalenceByStation: [[0, 0, 0, 33.3, 17.8, 1]],
    prevalenceByFarm: [[0, 0, 0, 30, null, 2]],
    ...over,
  };
}

function lookup(p: TrendsPayload, sel: Selection, obs: ObsKey | null, stage: string | null = null) {
  return prevalenceForCell(buildMatrixIndex(p), buildPrevalenceIndex(p), sel, "2031-W10", obs, stage);
}

describe("prevalence band lookups", () => {
  it("reads a station's adjusted prevalence and its band", () => {
    expect(lookup(payload(), GH12, THRIPS)).toEqual({
      prevalence: 33.3, margin: 17.8, reliability: "Fair", lo: 15.5, hi: 51.1,
    });
  });

  it("reads a farm row, with no band when too clustered to judge", () => {
    expect(lookup(payload(), FARM, THRIPS)).toEqual({
      prevalence: 30, margin: null, reliability: "Low", lo: null, hi: null,
    });
  });

  it("has nothing for all observations or for a stage child", () => {
    expect(lookup(payload(), GH12, null)).toBeNull();
    expect(lookup(payload(), GH12, THRIPS, "Adult")).toBeNull();
  });

  it("floors at 0 and caps at 100", () => {
    const p = payload({ prevalenceByStation: [[0, 0, 0, 3, 8, 2]] });
    expect(lookup(p, GH12, THRIPS)).toMatchObject({ lo: 0, hi: 11 });
    const q = payload({ prevalenceByStation: [[0, 0, 0, 97, 8, 2]] });
    expect(lookup(q, GH12, THRIPS)).toMatchObject({ lo: 89, hi: 100 });
  });

  it("tolerates a payload without the prevalence tables", () => {
    const p = payload({ prevalenceByStation: undefined, prevalenceByFarm: undefined });
    expect(lookup(p, GH12, THRIPS)).toBeNull();
  });

  it("builds bands keyed by the selection's series", () => {
    const p = payload();
    const byWeek = buildPrevalenceByWeek(p.allWeeks, buildMatrixIndex(p), buildPrevalenceIndex(p), [GH12, FARM], THRIPS, null);
    const bands = buildMarginBands(byWeek, [GH12, FARM]);
    expect(bands.get("2031-W10")).toEqual({ [`GH 12${BAND_SUFFIX}`]: [15.5, 51.1] });
  });

  it("overlays adjusted prevalence onto the line, turning weeks without a row into gaps", () => {
    const p = payload();
    const byWeek = buildPrevalenceByWeek(p.allWeeks, buildMatrixIndex(p), buildPrevalenceIndex(p), [GH12, FARM], THRIPS, null);
    const out = overlayPrevalence([{ date: "2031-W10", "GH 12": 33.3 - 10, "Karen Farm": 5 }], byWeek, [GH12, FARM]);
    expect(out).toEqual([{ date: "2031-W10", "GH 12": 33.3, "Karen Farm": 30 }]);
  });

  it("band mode keeps a clean scouted week at 0 and leaves an unscouted week as a gap", () => {
    // W10 infested, W11 scouted clean (server sends a 0 % row), W12 unscouted (no row).
    const p = payload({
      vocab: {
        weeks: ["2031-W10", "2031-W11", "2031-W12"], stations: ["GH 12", "GH 13"], obs: ["pest:Thrips"],
        stages: [""], farms: ["Karen Farm"], reliability: ["Good", "Fair", "Low"],
      },
      allWeeks: ["2031-W10", "2031-W11", "2031-W12"],
      prevalenceByStation: [[0, 0, 0, 33.3, 17.8, 1], [1, 0, 0, 0, 9.3, 0]],
      prevalenceByFarm: [],
    });
    const byWeek = buildPrevalenceByWeek(p.allWeeks, buildMatrixIndex(p), buildPrevalenceIndex(p), [GH12], THRIPS, null);
    const out = overlayPrevalence(
      [{ date: "2031-W10", "GH 12": 1 }, { date: "2031-W11", "GH 12": null }, { date: "2031-W12", "GH 12": null }],
      byWeek,
      [GH12],
    );
    expect(out.map((r) => r["GH 12"])).toEqual([33.3, 0, null]);
    expect(buildMarginBands(byWeek, [GH12]).get("2031-W11")).toEqual({ [`GH 12${BAND_SUFFIX}`]: [0, 9.3] });
    // …and the band-mode line must not bridge the unscouted null.
    expect(lineConnectsNulls(true)).toBe(false);
    expect(lineConnectsNulls(false)).toBe(true);
  });
});
