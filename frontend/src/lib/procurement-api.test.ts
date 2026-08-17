/**
 * The pure helpers behind the procurement page.
 *
 * `resolveReduction` mirrors the server so the GM sees what a cut resolves to
 * before committing — which means the two must agree. The cases here are the same
 * ones `test_apportion` / `test_procurement` pin server-side.
 */
import { describe, expect, it } from "vitest";
import {
  describeCredit,
  describeRequirement,
  isEditable,
  resolveReduction,
  type Requirement,
} from "./procurement-api";

describe("resolveReduction", () => {
  it("leaves the total alone when there is no cut", () => {
    expect(resolveReduction(100, "None", 0)).toBe(100);
    expect(resolveReduction(100, "None", 42)).toBe(100);
  });

  it("takes an absolute figure as the new total", () => {
    expect(resolveReduction(100, "Absolute", 80)).toBe(80);
  });

  it("takes a percentage as the size of the cut, not the remainder", () => {
    // 25% off 100 is 75, matching the worked example in the decisions record.
    expect(resolveReduction(100, "Percentage", 25)).toBe(75);
    expect(resolveReduction(50, "Percentage", 10)).toBe(45);
  });

  it("never approves more than was asked for", () => {
    expect(resolveReduction(100, "Absolute", 5000)).toBe(100);
  });

  it("clamps a nonsense percentage instead of going negative", () => {
    expect(resolveReduction(100, "Percentage", 150)).toBe(0);
    expect(resolveReduction(100, "Percentage", -20)).toBe(100);
  });

  it("treats a blank value as zero", () => {
    expect(resolveReduction(100, "Absolute", NaN)).toBe(0);
    expect(resolveReduction(100, "Percentage", NaN)).toBe(100);
  });
});

describe("describeCredit", () => {
  it("says which way the debt runs", () => {
    expect(describeCredit(0.4, "kg")).toBe("owed 0.4 kg");
    expect(describeCredit(-0.4, "kg")).toBe("paid ahead 0.4 kg");
  });

  it("calls float dust settled rather than showing 0.000", () => {
    expect(describeCredit(1e-12)).toBe("settled");
    expect(describeCredit(0)).toBe("settled");
  });

  it("trims trailing zeros so the number reads as a quantity", () => {
    expect(describeCredit(5, "g")).toBe("owed 5 g");
    expect(describeCredit(2.5, "g")).toBe("owed 2.5 g");
  });
});

describe("isEditable", () => {
  it("only a draft is edited in place — everything else needs an amendment", () => {
    expect(isEditable("Draft")).toBe(true);
    for (const s of [
      "Submitted",
      "Planner Approved",
      "Rejected",
      "Amendment Requested",
      "Superseded",
    ] as const) {
      expect(isEditable(s)).toBe(false);
    }
  });
});

describe("describeRequirement", () => {
  const base: Requirement = {
    name: "CPR-1",
    farm: "Karen",
    cycle: "CPC-1",
    status: "Draft",
    items: [],
  };

  it("distinguishes an empty draft from a filled one", () => {
    expect(describeRequirement(base)).toBe("nothing added yet");
    expect(
      describeRequirement({
        ...base,
        items: [{ item_code: "A", requested_qty: 1 }],
      }),
    ).toContain("1 chemical");
  });

  it("puts the rejection reason in front of the planner", () => {
    expect(
      describeRequirement({
        ...base,
        status: "Rejected",
        rejection_reason: "too much for the block",
      }),
    ).toBe("rejected: too much for the block");
  });

  it("still explains a rejection with no reason recorded", () => {
    expect(describeRequirement({ ...base, status: "Rejected" })).toContain(
      "amendment",
    );
  });
});
