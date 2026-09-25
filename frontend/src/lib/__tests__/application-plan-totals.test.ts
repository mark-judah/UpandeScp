/** The bug this covers: a plan whose totals were all zero while the Water
 *  Volume box plainly read 1000.00.
 *
 *  The component derived the totals from an effect keyed on the water volume
 *  alone. Rows arrive from the BOM with ``stock_qty: 0``, so they were only
 *  ever filled in if the volume changed AFTERWARDS — picking the BOM after
 *  the scope (the order the form itself reads in) left every total at 0 and
 *  the submit refused with "Water volume not set — BELT has no total qty."
 *
 *  The fix lets the effect depend on the rows too, which is only safe while
 *  an unchanged pass returns the original array. Both halves are asserted
 *  here, because dropping the second reintroduces an infinite render loop
 *  rather than a wrong number.
 */

import { describe, it, expect } from "vitest";
import { applyWaterVolume } from "@/lib/application-plan-totals";

const fromBom = () => [
  { item_code: "CHE00017", rate: 0.3, stock_qty: 0 },
  { item_code: "CHE00087", rate: 0.1, stock_qty: 0 },
  { item_code: "CHE00040", rate: 1, stock_qty: 0 },
];

describe("applyWaterVolume", () => {
  it("fills in rows that arrive from the BOM with a zero total", () => {
    const out = applyWaterVolume(fromBom(), "1000.00");
    expect(out.map((r) => r.stock_qty)).toEqual([0.3, 0.1, 1]);
  });

  it("scales by the water volume, not by 1000 flat", () => {
    const out = applyWaterVolume(fromBom(), 2500);
    expect(out.map((r) => r.stock_qty)).toEqual([0.75, 0.25, 2.5]);
  });

  it("returns the very same array when nothing moved", () => {
    // The anti-loop guarantee: the component depends on these rows, so a new
    // array here means the effect that produced it runs again forever.
    const settled = applyWaterVolume(fromBom(), 1000);
    expect(applyWaterVolume(settled, 1000)).toBe(settled);
  });

  it("settles after exactly one pass", () => {
    const first = applyWaterVolume(fromBom(), 1750);
    const second = applyWaterVolume(first, 1750);
    expect(second).toBe(first);
  });

  it("leaves rows alone until a water volume exists", () => {
    const rows = fromBom();
    expect(applyWaterVolume(rows, "")).toBe(rows);
    expect(applyWaterVolume(rows, 0)).toBe(rows);
  });

  it("does not touch a row with no rate", () => {
    const rows = [{ item_code: "ADHOC", rate: 0, stock_qty: 0 }];
    expect(applyWaterVolume(rows, 1000)).toBe(rows);
  });

  it("rounds to four places, the precision the store issues in", () => {
    const out = applyWaterVolume([{ rate: 0.33333, stock_qty: 0 }], 1000);
    expect(out[0].stock_qty).toBe(0.3333);
  });
});
