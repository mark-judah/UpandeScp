/**
 * The create-tank-mix dialog's dose validation.
 *
 * The dialog had no dose field at all: it sent `{item_code, item_name, qty: 1,
 * stock_uom}` while `create_bom.createBOM` reads `custom_application_rate` and
 * rejects anything <= 0. So every attempt, by every user, on every site, came
 * back as:
 *
 *     Rate must be > 0 for 'Acrecio' (row #1)
 *
 * These pin the guard that now runs before the round-trip.
 */
import { describe, expect, it } from "vitest";

import { newBomRateError, type NewBomChem } from "../ApplicationPlan";

const chem = (rate?: string): NewBomChem => ({
  item_code: "ACRECIO",
  item_name: "Acrecio",
  stock_uom: "Litre",
  rate,
});

describe("newBomRateError", () => {
  it("rejects a row with no dose — the original bug", () => {
    expect(newBomRateError(chem(undefined))).toBe("Dose required.");
    expect(newBomRateError(chem(""))).toBe("Dose required.");
  });

  it("rejects whitespace as if it were empty", () => {
    expect(newBomRateError(chem("   "))).toBe("Dose required.");
  });

  it("rejects zero and negatives", () => {
    expect(newBomRateError(chem("0"))).toBe("Must be greater than 0.");
    expect(newBomRateError(chem("0.0"))).toBe("Must be greater than 0.");
    expect(newBomRateError(chem("-1"))).toBe("Must be greater than 0.");
  });

  it("rejects values that are not numbers", () => {
    expect(newBomRateError(chem("abc"))).toBe("Not a number.");
    expect(newBomRateError(chem("1.2.3"))).toBe("Not a number.");
  });

  it("accepts a positive dose", () => {
    expect(newBomRateError(chem("1"))).toBeNull();
    expect(newBomRateError(chem("0.5"))).toBeNull();
    expect(newBomRateError(chem("0.001"))).toBeNull();
    expect(newBomRateError(chem("1200"))).toBeNull();
  });

  it("accepts a dose the operator is still typing", () => {
    // Held as a string precisely so "0." doesn't collapse to 0 mid-keystroke
    // and flash an error at someone typing "0.5".
    expect(newBomRateError(chem("0.5"))).toBeNull();
  });

  it("tolerates surrounding whitespace on a real value", () => {
    expect(newBomRateError(chem(" 0.5 "))).toBeNull();
  });
});
