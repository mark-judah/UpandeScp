import { afterEach, describe, expect, it, vi } from "vitest";
import {
  farmOf, farmPrefix, focusFarm, nameOnFarms, nameOnHouses, placeSetFromFilter, placeSetToFilter, houseLabel, housesOf, inPlaceSet, matchesQuery, singlePlace, placeKey, readPlace, shortHouse, writePlace,
} from "@/lib/places";

const FARMS = {
  Chepsito: ["Chepsito GH 16 - KR", "Chepsito GH 02 - KR"],
  Endebess: ["Q - KL", "P2 - KL"],
  "Chepsito North": ["Chepsito North GH 1 - KR"],
};

describe("shortHouse / houseLabel", () => {
  it("drops only the company suffix, keeping the farm in the name", () => {
    expect(shortHouse("Chepsito GH 16 - KR", "Chepsito")).toBe("Chepsito GH 16");
    expect(shortHouse("Chepsito GH 16 - KR")).toBe("Chepsito GH 16");
    expect(shortHouse("_Test SCP Units BLK 3 - TPC", "_Test SCP Units")).toBe("_Test SCP Units BLK 3");
    expect(shortHouse("Q - KL", "Endebess")).toBe("Q");
    expect(shortHouse("", "Chepsito")).toBe("");
  });

  it("writes the pill as the full name, not farm · house", () => {
    expect(houseLabel("Chepsito GH 16 - KR", "Chepsito")).toBe("Chepsito GH 16");
    expect(houseLabel("Q - KL", "Endebess")).toBe("Q");
    expect(houseLabel("Chepsito GH 16 - KR")).toBe("Chepsito GH 16");
  });
});

describe("farmOf", () => {
  it("uses the farm data first", () => {
    expect(farmOf("Q - KL", FARMS)).toBe("Endebess");
    expect(farmOf("Chepsito North GH 1 - KR", FARMS)).toBe("Chepsito North");
  });

  it("falls back to the longest farm prefix", () => {
    expect(farmOf("Chepsito North GH 9 - KR", ["Chepsito", "Chepsito North"])).toBe("Chepsito North");
    expect(farmOf("Chepsito GH 9 - KR", FARMS)).toBe("Chepsito");
    expect(farmOf("Nowhere GH 1", FARMS)).toBe("");
    expect(farmOf(null, FARMS)).toBe("");
  });
});

describe("farmPrefix", () => {
  it("reads the farm off a house name when there is no farm data", () => {
    expect(farmPrefix("Chepsito GH 16 - KR")).toBe("Chepsito");
    expect(farmPrefix("_Test SCP Units BLK 3 - TPC")).toBe("_Test SCP Units");
    expect(farmPrefix("Q - KL")).toBe("Q");
    expect(farmPrefix(null)).toBe("");
  });
});

describe("housesOf", () => {
  it("lists one farm or every farm, sorted", () => {
    expect(housesOf(FARMS, "Chepsito")).toEqual(["Chepsito GH 02 - KR", "Chepsito GH 16 - KR"]);
    expect(housesOf(FARMS, "")).toHaveLength(5);
    expect(housesOf(FARMS, "Missing")).toEqual([]);
  });
});

describe("matchesQuery", () => {
  it("ignores case and spaces", () => {
    expect(matchesQuery("Chepsito GH 16 - KR", "gh16")).toBe(true);
    expect(matchesQuery("Chepsito Chepsito GH 16 - KR", "chep 16")).toBe(true);
    expect(matchesQuery("Chepsito GH 16 - KR", "GH 17")).toBe(false);
    expect(matchesQuery("anything", "  ")).toBe(true);
  });
});

describe("readPlace / writePlace", () => {
  afterEach(() => vi.restoreAllMocks());

  it("round-trips per crop", () => {
    writePlace("Rose", { farm: "Chepsito", greenhouse: "Chepsito GH 16 - KR" });
    expect(readPlace("Rose")).toEqual({ farm: "Chepsito", greenhouse: "Chepsito GH 16 - KR" });
    expect(readPlace("Avocado")).toBeNull();
    expect(placeKey("Rose")).toBe("scp.place.Rose");
  });

  it("survives junk and storage that throws", () => {
    window.localStorage.setItem(placeKey("Rose"), "{not json");
    expect(readPlace("Rose")).toBeNull();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readPlace("Rose")).toBeNull();
    expect(() => writePlace("Rose", { farm: "A", greenhouse: "" })).not.toThrow();
  });
});

describe("inPlaceSet / singlePlace", () => {
  const none = { farms: [], greenhouses: [] };
  it("the empty set holds every house", () => {
    expect(inPlaceSet(none, "Chepsito", "Chepsito GH 16 - KR")).toBe(true);
  });
  it("a whole farm or a loose house is in; anything else is out", () => {
    const set = { farms: ["Endebess"], greenhouses: ["Chepsito GH 16 - KR"] };
    expect(inPlaceSet(set, "Endebess", "Q - KL")).toBe(true);
    expect(inPlaceSet(set, "Chepsito", "Chepsito GH 16 - KR")).toBe(true);
    expect(inPlaceSet(set, "Chepsito", "Chepsito GH 02 - KR")).toBe(false);
  });
  it("singlePlace is set only for exactly one farm or one house", () => {
    expect(singlePlace(none)).toBeNull();
    expect(singlePlace({ farms: ["A"], greenhouses: [] })).toEqual({ farm: "A", greenhouse: "" });
    expect(singlePlace({ farms: [], greenhouses: ["H"] })).toEqual({ farm: "", greenhouse: "H" });
    expect(singlePlace({ farms: ["A"], greenhouses: ["H"] })).toBeNull();
  });
});

describe("map header filter <-> PlaceSet", () => {
  it("a whole-farm pick carries only the farm list", () => {
    expect(placeSetToFilter({ farms: ["Chepsito"], greenhouses: [] }, FARMS)).toEqual({ farm: "Chepsito", greenhouse: "" });
    expect(placeSetToFilter({ farms: ["Chepsito", "Endebess"], greenhouses: [] }, FARMS)).toEqual({
      farm: JSON.stringify(["Chepsito", "Endebess"]),
      greenhouse: "",
    });
    expect(placeSetToFilter({ farms: [], greenhouses: [] }, FARMS)).toEqual({ farm: "", greenhouse: "" });
  });
  it("loose houses carry the houses and the farms they sit on", () => {
    const p = placeSetToFilter({ farms: ["Endebess"], greenhouses: ["Chepsito GH 16 - KR"] }, FARMS);
    expect(JSON.parse(p.greenhouse)).toEqual(["Chepsito GH 16 - KR", "Q - KL", "P2 - KL"]);
    expect(JSON.parse(p.farm)).toEqual(["Chepsito", "Endebess"]);
    expect(placeSetToFilter({ farms: [], greenhouses: ["Chepsito GH 16 - KR"] }, FARMS)).toEqual({
      farm: "Chepsito",
      greenhouse: "Chepsito GH 16 - KR",
    });
  });
  it("reads it back, folding full farms", () => {
    expect(placeSetFromFilter("Chepsito", "", FARMS)).toEqual({ farms: ["Chepsito"], greenhouses: [] });
    expect(placeSetFromFilter("Chepsito", "Chepsito GH 16 - KR", FARMS)).toEqual({ farms: [], greenhouses: ["Chepsito GH 16 - KR"] });
    expect(
      placeSetFromFilter("", JSON.stringify(["Q - KL", "P2 - KL"]), FARMS),
    ).toEqual({ farms: ["Endebess"], greenhouses: [] });
    expect(placeSetFromFilter("__all__", "__all__", FARMS)).toEqual({ farms: [], greenhouses: [] });
  });
  it("name matching and fly-to focus", () => {
    const two = JSON.stringify(["Chepsito", "Endebess"]);
    expect(nameOnFarms("Endebess P2 - KL", two)).toBe(true);
    expect(nameOnFarms("Torongo GH 1", two)).toBe(false);
    expect(nameOnFarms("Torongo GH 1", "__all__")).toBe(true);
    expect(nameOnHouses("Chepsito GH 16 - KR-Z1", JSON.stringify(["Chepsito GH 16 - KR"]))).toBe(true);
    expect(nameOnHouses("Chepsito GH 02 - KR", "Chepsito GH 16 - KR")).toBe(false);
    expect(focusFarm(two)).toBe("Chepsito");
    expect(focusFarm("__all__")).toBe("");
  });
});
