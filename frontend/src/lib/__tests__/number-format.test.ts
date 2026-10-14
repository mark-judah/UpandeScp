import { describe, expect, it } from "vitest";
import { formatAmount } from "@/lib/number-format";

describe("formatAmount", () => {
  it("uses thousands separators and exactly 2 decimals", () => {
    expect(formatAmount(1309017.25)).toBe("1,309,017.25");
    expect(formatAmount(5)).toBe("5.00");
    expect(formatAmount(0.1 + 0.2)).toBe("0.30");
    expect(formatAmount(-1234.5)).toBe("-1,234.50");
  });
  it("never carries a currency", () => {
    expect(formatAmount(1000)).not.toMatch(/[A-Za-z$€£]/);
  });
  it("treats missing values as zero", () => {
    expect(formatAmount(undefined)).toBe("0.00");
    expect(formatAmount(null)).toBe("0.00");
  });
});
