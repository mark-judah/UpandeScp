import { describe, it, expect } from "vitest";
import {
  plannedDay,
  plannedSummary,
  topTotals,
  type PlannedRow,
  type PlannedTotal,
} from "./planned-chemicals";

const total = (item_code: string, total_qty: number, uom = "Litre"): PlannedTotal => ({
  item_code,
  item_name: item_code,
  uom,
  total_qty,
});

const row = (work_order: string, total_qty: number, item_count = 1): PlannedRow => ({
  work_order,
  planned_date: "2026-09-04 06:00:00",
  greenhouse: "Chepsito GH 19 - KR",
  farm: "Chepsito",
  item_count,
  total_qty,
});

describe("the totals strip", () => {
  it("shows the heaviest demand and counts the rest", () => {
    // A keeper reading the strip is deciding what to carry; the long tail of
    // 50 chemicals is noise on that walk, but it must not simply vanish.
    const totals = Array.from({ length: 9 }, (_, i) => total(`C${i}`, 10 - i));
    const { shown, extraCount } = topTotals(totals, 6);
    expect(shown.map((t) => t.item_code)).toEqual(["C0", "C1", "C2", "C3", "C4", "C5"]);
    expect(extraCount).toBe(3);
  });

  it("says nothing about a tail that does not exist", () => {
    const { shown, extraCount } = topTotals([total("A", 1), total("B", 2)], 6);
    expect(shown).toHaveLength(2);
    expect(extraCount).toBe(0);
  });

  it("survives an empty list", () => {
    expect(topTotals([], 6)).toEqual({ shown: [], extraCount: 0 });
  });

  it("does not reorder what the server ranked", () => {
    // The server sorts by quantity; re-sorting here would silently disagree
    // with it the moment the two definitions of "biggest" drift apart.
    const totals = [total("B", 9), total("A", 1)];
    expect(topTotals(totals, 6).shown.map((t) => t.item_code)).toEqual(["B", "A"]);
  });
});

describe("the section's own summary line", () => {
  it("counts plans, not chemicals", () => {
    const s = plannedSummary([row("WO-1", 2, 3), row("WO-2", 1, 1)]);
    expect(s.plans).toBe(2);
    expect(s.totalQty).toBeCloseTo(3);
  });

  it("uses the singular for one plan", () => {
    expect(plannedSummary([row("WO-1", 1)]).label).toMatch(/^1 plan awaiting/);
  });

  it("uses the plural for several", () => {
    expect(plannedSummary([row("A", 1), row("B", 1)]).label).toMatch(/^2 plans awaiting/);
  });

  it("says plainly when there is nothing waiting", () => {
    const s = plannedSummary([]);
    expect(s.plans).toBe(0);
    expect(s.label).toMatch(/nothing/i);
  });
});

describe("the date a plan is meant to be sprayed", () => {
  it("drops the time — the store works in days", () => {
    expect(plannedDay("2026-09-04 06:00:00")).toBe("2026-09-04");
  });

  it("passes a bare date through untouched", () => {
    expect(plannedDay("2026-09-04")).toBe("2026-09-04");
  });

  it("shows a dash rather than 'null' when a plan has no date", () => {
    expect(plannedDay("")).toBe("—");
    expect(plannedDay(null)).toBe("—");
  });
});
