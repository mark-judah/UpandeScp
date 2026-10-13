import { describe, expect, it } from "vitest";
import { linkObsId, linkStationId, parseHeatmapLink } from "./heatmap-link";

describe("heatmap deep link", () => {
  it("parses the hash query and drops unknown kinds", () => {
    expect(parseHeatmapLink("#/rose/heatmaps?gh=Simotwo%20GH%2020%20-%20KR&obs=Thrips&kind=pest")).toEqual({
      gh: "Simotwo GH 20 - KR", obs: "Thrips", kind: "pest",
    });
    expect(parseHeatmapLink("#/rose/heatmaps?kind=weird").kind).toBe("");
    expect(parseHeatmapLink("#/rose/heatmaps")).toEqual({ gh: "", obs: "", kind: "" });
  });
  it("resolves the station only for a known house", () => {
    const farms = { "Simotwo GH 20 - KR": "Simotwo" };
    expect(linkStationId({ gh: "Simotwo GH 20 - KR", obs: "", kind: "" }, farms)).toBe("station:Simotwo|Simotwo GH 20 - KR");
    expect(linkStationId({ gh: "Nope", obs: "", kind: "" }, farms)).toBeNull();
  });
  it("resolves the target only when a card matches, honouring kind", () => {
    const cards = [{ obsName: "Thrips", obsKind: "pest" }, { obsName: "Thrips", obsKind: "disease" }];
    expect(linkObsId({ gh: "", obs: "Thrips", kind: "disease" }, cards)).toBe("obs:disease:Thrips");
    expect(linkObsId({ gh: "", obs: "Thrips", kind: "" }, cards)).toBe("obs:pest:Thrips");
    expect(linkObsId({ gh: "", obs: "Mites", kind: "" }, cards)).toBeNull();
  });
});
