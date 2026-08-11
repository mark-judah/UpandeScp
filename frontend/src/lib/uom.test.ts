import { describe, it, expect } from "vitest";
import { factorFor, fmtQty, fromStockQty, toStockQty } from "./uom";

// Foliar 1004 on kaitet: stocked in Bottle, 1 bottle = 500 g.
const UOMS = [
  { uom: "Bottle", conversion_factor: 1 },
  { uom: "Gram", conversion_factor: 0.002 },
];

describe("factorFor", () => {
  it("reads the item's factor", () => {
    expect(factorFor(UOMS, "Gram")).toBe(0.002);
    expect(factorFor(UOMS, "Bottle")).toBe(1);
  });

  it("falls back to 1 rather than guessing", () => {
    expect(factorFor(UOMS, "Furlong")).toBe(1);
    expect(factorFor(undefined, "Gram")).toBe(1);
    expect(factorFor([{ uom: "Gram", conversion_factor: 0 }], "Gram")).toBe(1);
  });
});

describe("fromStockQty — showing stock in the chosen unit", () => {
  it("turns 50 bottles into 25,000 grams", () => {
    // The actual case: "50" beside a gram rate would read as 50 g.
    expect(fromStockQty(50, UOMS, "Gram")).toBe(25000);
  });

  it("leaves the stock UOM unchanged", () => {
    expect(fromStockQty(50, UOMS, "Bottle")).toBe(50);
  });

  it("handles a fractional bottle", () => {
    expect(fromStockQty(11.5, UOMS, "Gram")).toBe(5750);
  });

  it("is 0 for junk rather than NaN", () => {
    expect(fromStockQty(NaN, UOMS, "Gram")).toBe(0);
  });
});

describe("toStockQty — round trip", () => {
  it("inverts fromStockQty", () => {
    expect(toStockQty(25000, UOMS, "Gram")).toBe(50);
    expect(toStockQty(5750, UOMS, "Gram")).toBe(11.5);
  });
});

describe("fmtQty", () => {
  it("groups thousands and trims noise", () => {
    expect(fmtQty(25000)).toBe("25,000");
    expect(fmtQty(11.5)).toBe("11.5");
    expect(fmtQty(11.004)).toBe("11");
  });
  it("handles junk", () => {
    expect(fmtQty(NaN)).toBe("—");
  });
});
