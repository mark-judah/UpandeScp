import { describe, it, expect } from "vitest";
import { availableStock } from "./stock-availability";

describe("availableStock", () => {
  it("subtracts server reservations and current-form usage from on-hand", () => {
    expect(availableStock({ onHand: 60, reservedFromServer: 55, draftFormUsage: 0 })).toBe(5);
    expect(availableStock({ onHand: 60, reservedFromServer: 50, draftFormUsage: 3 })).toBe(7);
  });
  it("never returns negative", () => {
    expect(availableStock({ onHand: 5, reservedFromServer: 10, draftFormUsage: 0 })).toBe(0);
  });
  it("treats missing numbers as zero", () => {
    expect(availableStock({ onHand: 5 } as any)).toBe(5);
  });
});
