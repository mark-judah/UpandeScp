import { describe, it, expect } from "vitest";
import { stagesFor, type StageFilterOptions } from "../pests-diseases-types";

const opts: StageFilterOptions = {
  sections: [],
  // The flat union — every stage anywhere in the dataset, pests and diseases.
  stages: ["Adult", "Egg", "Fresh", "Larvae", "Latent", "Nymph"],
  stagesByItem: {
    Thrips: ["Adult", "Larvae"],
    "Powdery Mildew": ["Fresh", "Latent"],
    "Unstaged Pest": [],
  },
};

describe("stagesFor", () => {
  it("returns the flat union when nothing is selected", () => {
    expect(stagesFor(opts, undefined)).toBe(opts.stages);
    expect(stagesFor(opts, "")).toBe(opts.stages);
  });

  it("narrows to the selected observation's own stages", () => {
    // The bug: picking Thrips still offered Fresh/Latent, which belong to a
    // disease and can never match a pest row.
    expect(stagesFor(opts, "Thrips")).toEqual(["Adult", "Larvae"]);
    expect(stagesFor(opts, "Powdery Mildew")).toEqual(["Fresh", "Latent"]);
  });

  it("falls back to the union for an item with no recorded stages", () => {
    // An empty picker reads as broken; showing everything is the lesser evil.
    expect(stagesFor(opts, "Unstaged Pest")).toBe(opts.stages);
  });

  it("falls back for an unknown item", () => {
    expect(stagesFor(opts, "Never Seen")).toBe(opts.stages);
  });

  it("falls back when the payload predates stagesByItem", () => {
    const legacy: StageFilterOptions = { sections: [], stages: ["Adult", "Egg"] };
    expect(stagesFor(legacy, "Thrips")).toEqual(["Adult", "Egg"]);
  });
});
