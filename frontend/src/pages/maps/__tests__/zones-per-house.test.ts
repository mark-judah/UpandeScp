import { describe, expect, it } from "vitest";
import { houseOf, zonesPerHouse } from "../zone-utils";

const zones = (house: string, beds: number, per: number) =>
  Array.from({ length: beds * per }, (_, i) => ({ bedName: `${house} - Bed ${Math.floor(i / per) + 1}` }));

describe("zonesPerHouse", () => {
  it("counts each house's own zones, not its neighbours'", () => {
    const m = zonesPerHouse([
      ...zones("Simotwo GH 20 - KR", 528, 8),
      ...zones("Simotwo GH 2 - KR", 10, 8),
      ...zones("Torongo GH 20 - KR", 5, 8),
    ]);
    expect(m.get("Simotwo GH 20 - KR")).toBe(4224);
    expect(m.get("Simotwo GH 2 - KR")).toBe(80);
    expect(m.get("Torongo GH 20 - KR")).toBe(40);
    expect(m.size).toBe(3);
  });
  it("reads the house from bed and zone names", () => {
    expect(houseOf("Simotwo GH 20 - KR - Bed 7")).toBe("Simotwo GH 20 - KR");
    expect(houseOf("Simotwo GH 20 - KR - Bed 7 - Zone 3")).toBe("Simotwo GH 20 - KR");
    expect(houseOf("Plain")).toBe("Plain");
  });
});
