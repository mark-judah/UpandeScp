import { beforeEach, describe, expect, it, vi } from "vitest";

const call = vi.fn();
vi.mock("./frappe", () => ({ call: (...a: unknown[]) => call(...a) }));

import {
  basisLabel, dilutionLine, fetchSprayProductRates, perBaseOf, perLabel, pickRow, quantityFor,
  rateFromQuantity, rateStatus, type RateRow,
} from "./spray-rates";

beforeEach(() => call.mockReset());

describe("quantityFor", () => {
  it("scales a Water rate per 1000 L", () => {
    expect(quantityFor(2, "Water", { waterL: 500 })).toBe(1);
  });
  it("scales a Hectarage rate per 10,000 m²", () => {
    expect(quantityFor(2, "Hectarage", { areaM2: 5000 })).toBe(1);
  });
  it("throws when the needed measure is missing", () => {
    expect(() => quantityFor(2, "Hectarage", { waterL: 500 })).toThrow(/area/);
    expect(() => quantityFor(2, "Water", { areaM2: 500 })).toThrow(/water/);
  });
});

describe("basisLabel", () => {
  it("shows the unit", () => {
    expect(basisLabel("Water")).toBe("Water · per 1000 L");
    expect(basisLabel("Hectarage")).toBe("Area · per 10,000 m²");
  });
});

describe("fetchSprayProductRates", () => {
  it("posts the codes as JSON with the crop", async () => {
    call.mockResolvedValue({ A: [] });
    expect(await fetchSprayProductRates(["A"], "Avocado")).toEqual({ A: [] });
    expect(call).toHaveBeenCalledWith(
      "upande_scp.serverscripts.common.spray_rates.get_spray_product_rates",
      { item_codes: '["A"]', crop: "Avocado" },
    );
  });
  it("skips the call with no codes", async () => {
    expect(await fetchSprayProductRates([])).toEqual({});
    expect(call).not.toHaveBeenCalled();
  });
});

describe("migration: the same numbers in give the same quantities out", () => {
  // Legacy rows carry no unit; the migrated rows carry per 1000 Litre / per 1 Hectare, which
  // the server reports as per_base 1000 and 10,000. Both must give identical quantities.
  const cases: [number, number][] = [[0.3, 500], [1, 2500], [2.75, 12345.6], [0.0125, 999]];
  it.each(cases)("Water rate %f at %f L", (rate, water) => {
    const legacy = quantityFor(rate, "Water", { waterL: water });
    expect(quantityFor(rate, "Water", { waterL: water }, 1000 * 1)).toBe(legacy);
    expect(legacy).toBe((rate * water) / 1000);
  });
  it.each(cases)("Area rate %f over %f m2", (rate, area) => {
    const legacy = quantityFor(rate, "Hectarage", { areaM2: area });
    expect(quantityFor(rate, "Hectarage", { areaM2: area }, 1 * 10000)).toBe(legacy);
    expect(legacy).toBe((rate * area) / 10000);
  });
  it("a bare row reads as the legacy unit", () => {
    expect(perBaseOf("Water", {})).toBe(1000);
    expect(perBaseOf("Hectarage", {})).toBe(10000);
    expect(perLabel("Water", {})).toBe("per 1000 L");
  });
});

describe("units", () => {
  it("per 1 Acre uses the converted denominator", () => {
    expect(quantityFor(2, "Hectarage", { areaM2: 8097.165990 }, 4048.582995)).toBeCloseTo(4);
  });
  it("per 100 L and per 100 ml of water", () => {
    expect(quantityFor(0.5, "Water", { waterL: 400 }, 100)).toBeCloseTo(2);
    // 100 ml = 0.1 L, so a rate per 100 ml of water scales by 1/0.1
    expect(quantityFor(0.01, "Water", { waterL: 50 }, 0.1)).toBeCloseTo(5);
  });
  it("labels the denominator", () => {
    expect(perLabel("Water", { per_qty: 100, per_uom: "Litre" })).toBe("per 100 Litre of water");
    expect(perLabel("Hectarage", { per_qty: 1, per_uom: "Acre" })).toBe("per Acre of area");
  });
});

describe("rate range, as the server reads it", () => {
  // The same cases are asserted in test_spray_rates.py::test_rate_status_cases.
  const cases: [string, number, number, "ok" | "below" | "above"][] = [
    // basis, per_base, quantity -> status, for lower 0.3 / upper 1 and measure 1000 L or 20000 m2
    ["Water", 1000, 0.2, "below"],
    ["Water", 1000, 0.5, "ok"],
    ["Water", 100, 20, "above"],
    ["Hectarage", 10000, 20, "above"],
    ["Hectarage", 4048.582995, 4, "ok"],
  ];
  it.each(cases)("%s per_base %f qty %f -> %s", (basis, perBase, qty, want) => {
    const measures = { areaM2: 20000, waterL: 1000 };
    const rate = rateFromQuantity(qty, basis as "Water" | "Hectarage", perBase, measures);
    expect(rateStatus(rate, { lower: 0.3, upper: 1 })).toBe(want);
  });
  it("missing measure is not a violation", () => {
    expect(rateStatus(rateFromQuantity(5, "Water", 1000, {}), { lower: 1, upper: 2 })).toBe("ok");
  });
});

describe("pickRow and dilution", () => {
  const w: RateRow = { basis: "Water", lower: 1, upper: 2, crop: null, source: "default" };
  const a: RateRow = { basis: "Hectarage", lower: 1, upper: 2, crop: null, source: "crop" };
  it("blocks prefer Area, greenhouses Water, both fall back", () => {
    expect(pickRow([w, a], true)).toBe(a);
    expect(pickRow([w, a], false)).toBe(w);
    expect(pickRow([a], false)).toBe(a);
    expect(pickRow([], true)).toBeNull();
  });
  it("dilution line per litre of water", () => {
    expect(dilutionLine(5, 2000, "Litre")).toBe("With 2000 L of water: 0.0025 Litre per litre");
    expect(dilutionLine(5, 0, "Litre")).toBeNull();
  });
});
