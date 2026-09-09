import { describe, it, expect } from "vitest";
import {
  DATE_BASIS_LABEL,
  dateBasisHint,
  groupByFarm,
  type DateBasis,
} from "./approval-grouping";

const plan = (name: string, farm?: string) => ({ name, farm });

describe("grouping by farm", () => {
  it("puts each plan under its farm", () => {
    const groups = groupByFarm([plan("a", "Torongo"), plan("b", "Karen"), plan("c", "Torongo")]);
    expect(groups.map((g) => g.farm)).toEqual(["Torongo", "Karen"]);
    expect(groups[0].plans.map((p) => p.name)).toEqual(["a", "c"]);
  });

  it("leads with the farm that has the most waiting", () => {
    const groups = groupByFarm([plan("a", "Karen"), plan("b", "Torongo"), plan("c", "Torongo")]);
    expect(groups[0].farm).toBe("Torongo");
  });

  it("breaks a tie alphabetically, so the order does not wander", () => {
    const groups = groupByFarm([plan("a", "Torongo"), plan("b", "Chepsito")]);
    expect(groups.map((g) => g.farm)).toEqual(["Chepsito", "Torongo"]);
  });

  it("keeps a plan whose farm is unknown rather than dropping it", () => {
    // An unlinked warehouse is a data gap to see, not a plan to lose.
    const groups = groupByFarm([plan("a", "Karen"), plan("b", undefined), plan("c", "")]);
    const unassigned = groups.find((g) => g.farm === "Unassigned");
    expect(unassigned?.plans.map((p) => p.name)).toEqual(["b", "c"]);
  });

  it("puts Unassigned last however big it is", () => {
    const groups = groupByFarm([
      plan("a", undefined), plan("b", undefined), plan("c", undefined), plan("d", "Karen"),
    ]);
    expect(groups[groups.length - 1].farm).toBe("Unassigned");
  });

  it("handles an empty list", () => {
    expect(groupByFarm([])).toEqual([]);
  });

  it("loses no plans", () => {
    const plans = [plan("a", "X"), plan("b", "Y"), plan("c"), plan("d", "X")];
    const total = groupByFarm(plans).reduce((n, g) => n + g.plans.length, 0);
    expect(total).toBe(plans.length);
  });
});

describe("which date is being filtered", () => {
  it("names both bases in the operator's words", () => {
    expect(DATE_BASIS_LABEL.scheduled).toBe("Spray date");
    expect(DATE_BASIS_LABEL.created).toBe("Date planned");
  });

  it("explains the difference rather than leaving it to be guessed", () => {
    expect(dateBasisHint("created")).toMatch(/written in this range/i);
    expect(dateBasisHint("scheduled")).toMatch(/sprayed in this range/i);
  });

  it("says something for every basis", () => {
    for (const b of ["scheduled", "created"] as DateBasis[]) {
      expect(dateBasisHint(b).length).toBeGreaterThan(20);
    }
  });
});
