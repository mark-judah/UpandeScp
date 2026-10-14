import { describe, expect, it } from "vitest";
import { formatFindingPlace, zoneNumber } from "@/lib/finding-place";

describe("formatFindingPlace", () => {
  it("writes house, bed number, zone number", () => {
    expect(
      formatFindingPlace({ farm: "Chepsito", greenhouse: "Chepsito GH 11 - KR", bed: "29", zone: "Chepsito GH 11 - KR - Bed 29 - Zone 7" }),
    ).toBe("Chepsito GH 11 · Bed 29 · Zone 7");
  });
  it("takes the bed from the zone name when the bed is blank", () => {
    expect(formatFindingPlace({ house: "GH1 - KR", zone: "GH1 - KR - Bed 4 - Zone 2" })).toBe("GH1 · Bed 4 · Zone 2");
  });
  it("accepts a bare zone number", () => {
    expect(zoneNumber("7")).toBe("7");
    expect(formatFindingPlace({ greenhouse: "GH1", bed: "4", zone: "7" })).toBe("GH1 · Bed 4 · Zone 7");
  });
  it("avocado: house, block, tree; no bed", () => {
    expect(formatFindingPlace({ farm: "Lokitela", greenhouse: "Lokitela", block: "B3", tree: "12" })).toBe("Lokitela · Block B3 · Tree 12");
  });
  it("falls back to the farm, and to empty", () => {
    expect(formatFindingPlace({ farm: "Chepsito" })).toBe("Chepsito");
    expect(formatFindingPlace({})).toBe("");
  });
});
