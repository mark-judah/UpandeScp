import { afterEach, describe, expect, it, vi } from "vitest";
import {
  farmOf, farmPrefix, houseLabel, housesOf, matchesQuery, placeKey, readPlace, shortHouse, writePlace,
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
