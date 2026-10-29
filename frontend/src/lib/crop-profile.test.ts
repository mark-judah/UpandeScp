import { afterEach, describe, expect, it } from "vitest";
import { __setCropProfiles, cropProfile, isBlockGrown, type CropProfile } from "./crop-profile";
import { viewNavMeta } from "@/components/AppSidebar";

const p = (slug: string, block_grown: boolean, level_labels: string[] = []): CropProfile => ({
  crop: slug,
  label: slug,
  slug,
  station_type: block_grown ? "Block" : "Greenhouse",
  block_grown,
  level_labels,
});

describe("crop profile", () => {
  afterEach(() => __setCropProfiles(null));

  it("classifies by the data, not the name", () => {
    __setCropProfiles([p("rose", false), p("avocado", true, ["Phase", "Section"]), p("potato", true, ["Pivot"])]);
    expect(isBlockGrown("rose")).toBe(false);
    expect(isBlockGrown("avocado")).toBe(true);
    expect(isBlockGrown("potato")).toBe(true);
    expect(cropProfile("potato")?.level_labels).toEqual(["Pivot"]);
  });

  it("a crop with no profile defaults to the greenhouse pages", () => {
    __setCropProfiles([]);
    expect(isBlockGrown("avocado")).toBe(false);
  });

  it("a block-grown crop gets the block nav (Application Plan) whatever it is called", () => {
    __setCropProfiles([p("passion-fruit", true)]);
    expect(viewNavMeta("application-plan", "passion-fruit")).toEqual({ label: "Application Plan", section: "Crop Protection" });
    __setCropProfiles([p("passion-fruit", false)]);
    expect(viewNavMeta("heatmaps", "passion-fruit")?.label).toBe("Heatmaps");
  });
});
