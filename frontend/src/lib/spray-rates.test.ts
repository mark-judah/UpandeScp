import { beforeEach, describe, expect, it, vi } from "vitest";

const call = vi.fn();
vi.mock("./frappe", () => ({ call: (...a: unknown[]) => call(...a) }));

import { basisLabel, fetchSprayProductRates, quantityFor } from "./spray-rates";

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
    expect(basisLabel("Hectarage")).toBe("Hectarage · per 10,000 m²");
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
