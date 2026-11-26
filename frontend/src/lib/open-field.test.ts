import { describe, expect, it } from "vitest";
import type { RateRow } from "@/lib/spray-rates";
import {
  COLLAPSE_ABOVE,
  effectiveArea,
  chemicalQty,
  defaultRate,
  emptyPlan,
  METHODS,
  rateOutOfRange,
  withRateRows,
  groupState,
  planProblems,
  reservedElsewhere,
  shortStockRows,
  shouldCollapse,
  usageByStore,
  toDraftPayload,
  toggleGroup,
  type OpenFieldBlock,
} from "@/lib/open-field";

const blk = (name: string, over: Partial<OpenFieldBlock> = {}): OpenFieldBlock => ({
  name,
  label: name.replace(/ - MUT$/, ""),
  farm: "Mutara",
  crop: "Potato",
  crop_label: "Potato",
  area_ha: 2,
  cost_center: name,
  ...over,
});

const twelve = Array.from({ length: 12 }, (_, i) => blk(`P1-B${i + 1} - MUT`));

describe("selection", () => {
  it("select-all on a group adds every block of it, whatever the count", () => {
    const next = toggleGroup([], twelve);
    expect(next).toHaveLength(12);
    expect(next[0]).toBe("P1-B1 - MUT");
  });

  it("select-all keeps blocks already chosen elsewhere and the order of choice", () => {
    const next = toggleGroup(["Avocado Block A - MUT", "P1-B3 - MUT"], twelve);
    expect(next.slice(0, 2)).toEqual(["Avocado Block A - MUT", "P1-B3 - MUT"]);
    expect(next).toHaveLength(13);
  });

  it("toggling a fully selected group clears just that group", () => {
    const all = toggleGroup(["Avocado Block A - MUT"], twelve);
    expect(toggleGroup(all, twelve)).toEqual(["Avocado Block A - MUT"]);
  });

  it("group state is none, some or all", () => {
    expect(groupState([], twelve)).toBe("none");
    expect(groupState(["P1-B1 - MUT"], twelve)).toBe("some");
    expect(groupState(twelve.map((b) => b.name), twelve)).toBe("all");
  });
});

describe("collapse", () => {
  it("collapses to one open block once more than two are selected", () => {
    expect(COLLAPSE_ABOVE).toBe(2);
    expect(shouldCollapse(1)).toBe(false);
    expect(shouldCollapse(2)).toBe(false);
    expect(shouldCollapse(3)).toBe(true);
  });
});

describe("plan completeness", () => {
  const ok = {
    ...emptyPlan(),
    classification: "Curative" as const,
    team: "Spray 1",
    bom: "BOM-1",
    water: "2000",
    targets: ["Thrips"],
    chemicals: [{ item_code: "X", item_name: "X", stock_uom: "Litre", basis: "Water" as const, rate: 1, source: "Chemical Store - MUT" }],
  };

  it("at least one target is needed", () => {
    expect(planProblems({ ...ok, targets: [] }, 2)).toContain("a target");
  });

  it("a new plan lacks everything", () => {
    const p = planProblems(emptyPlan(), 2);
    expect(p).toEqual(expect.arrayContaining(["Preventive or Curative", "team", "tank mix"]));
  });

  it("a finished plan has no problems", () => {
    expect(planProblems(ok, 2)).toEqual([]);
  });

  it("preventive needs a 20 character reason", () => {
    expect(planProblems({ ...ok, classification: "Preventive" }, 2)).toContain("a reason");
    expect(
      planProblems({ ...ok, classification: "Preventive", reason: "Routine fortnightly cover in the wet season" }, 2),
    ).toEqual([]);
  });

  it("a block without area cannot be planned until one is typed", () => {
    expect(planProblems(ok, 0)).toContain("the block area");
    const typed = { ...ok, area: "1.5" };
    expect(effectiveArea(blk("A - MUT", { area_ha: 0 }), typed)).toBe(1.5);
    expect(planProblems(typed, effectiveArea(blk("A - MUT", { area_ha: 0 }), typed))).toEqual([]);
  });
});

describe("method of application", () => {
  it("defaults to foliar spraying and rides on the draft payload", () => {
    expect(emptyPlan().method).toBe("Spraying (foliar)");
    expect(METHODS).toEqual(["Spraying (foliar)", "Dusting", "Chemigation"]);
    const p = toDraftPayload(blk("P1-B1 - MUT"), { ...emptyPlan(), method: "Dusting" }, 1, "2026-10-30 06:00:00");
    expect(p.custom_method_of_application).toBe("Dusting");
    const d = toDraftPayload(blk("P1-B1 - MUT"), emptyPlan(), 1, "2026-10-30 06:00:00");
    expect(d.custom_method_of_application).toBe("Spraying (foliar)");
  });
});

describe("payload", () => {
  it("is a one-block draft: block as greenhouse, typed water, quantity = rate x litres / 1000", () => {
    const p = toDraftPayload(blk("P1-B1 - MUT"), {
      ...emptyPlan(),
      water: "2500",
      classification: "Curative",
      team: "Spray 1",
      bom: "BOM-1",
      kit: "Kit 1",
      targets: ["Thrips"],
      chemicals: [{ item_code: "X", item_name: "X", stock_uom: "Litre", basis: "Water" as const, rate: 2, source: "Chemical Store - MUT" }],
    }, 2.5, "2026-10-30 06:00:00");
    expect(p.custom_greenhouse).toBe("P1-B1 - MUT");
    expect(p.custom_blocks).toBeUndefined();
    expect(p.custom_area).toBe(2.5);
    expect(p.custom_water_volume).toBe(2500);
    expect(p.chemicals[0]).toMatchObject({ item_code: "X", application_rate: 5, source_warehouse: "Chemical Store - MUT" });
    expect(p.production_item).toBe("BOM-1");
    expect(p.custom_scope).toBe("Whole Block");
    expect(p.custom_targets).toEqual(["Thrips"]);
    expect(p.custom_scheduled_application_time).toBe("2026-10-30 06:00:00");
  });
});

describe("rates by basis", () => {
  const water: RateRow = { basis: "Water", lower: 0.5, upper: 1, crop: null, source: "default" };
  const ha: RateRow = { basis: "Hectarage", lower: 2, upper: 4, crop: "Potato", source: "crop" };
  const chem = { item_code: "X", item_name: "X", stock_uom: "Litre", basis: "Water" as const, rate: 2 };

  it("an Area rate takes its quantity from the block's area (rate x m2 / 10,000)", () => {
    expect(chemicalQty({ rate: 3, basis: "Hectarage" }, 2.5, 0)).toBeCloseTo(7.5);
  });
  it("a Water rate takes it from the typed water volume", () => {
    expect(chemicalQty({ rate: 2, basis: "Water" }, 2.5, 2500)).toBeCloseTo(5);
  });
  it("no measure, no quantity: Water without water, Area without area", () => {
    expect(chemicalQty({ rate: 3, basis: "Hectarage" }, 0, 900)).toBe(0);
    expect(chemicalQty({ rate: 2, basis: "Water" }, 2.5, 0)).toBe(0);
  });
  it("a unit rescales: per 100 L, per Acre", () => {
    expect(chemicalQty({ rate: 0.5, basis: "Water", per_base: 100 }, 1, 400)).toBeCloseTo(2);
    expect(chemicalQty({ rate: 1, basis: "Hectarage", per_base: 4048.582995 }, 2, 0)).toBeCloseTo(20000 / 4048.582995);
  });
  it("a mixed tank: the Area product by area, the Water product by water", () => {
    const p = toDraftPayload(blk("P1-B1 - MUT"), {
      ...emptyPlan(), water: "1500", classification: "Curative", team: "T", bom: "B", targets: ["Thrips"],
      chemicals: [
        { item_code: "A", basis: "Hectarage", rate: 3, stock_uom: "Litre" },
        { item_code: "W", basis: "Water", rate: 2, stock_uom: "Litre" },
      ],
    }, 2.5, "2026-10-30 06:00:00");
    expect(p.chemicals.map((c) => c.application_rate)).toEqual([7.5, 3]);
    expect(p.custom_water_volume).toBe(1500);
  });
  it("water is required only when the mix holds a Water product", () => {
    const base = { ...emptyPlan(), classification: "Curative" as const, team: "T", bom: "B", targets: ["Thrips"] };
    const area = { item_code: "A", basis: "Hectarage" as const, rate: 3 };
    const water = { item_code: "W", basis: "Water" as const, rate: 2 };
    expect(planProblems({ ...base, chemicals: [area] }, 2)).toEqual([]);
    expect(planProblems({ ...base, chemicals: [area, water] }, 2)).toContain("the water volume");
    expect(planProblems({ ...base, water: "800", chemicals: [area, water] }, 2)).toEqual([]);
  });
  it("a product with a Hectarage row for the crop is planned on it, at the middle of its range", () => {
    const c = withRateRows(chem, [ha, water]);
    expect(c).toMatchObject({ basis: "Hectarage", rate: 3, lower: 2, upper: 4 });
  });
  it("a Water row set per 100 L rescales the tank mix's per-1000 L rate into its own unit", () => {
    const per100: RateRow = { ...water, per_qty: 100, per_uom: "Litre", per_base: 100 };
    expect(withRateRows(chem, [per100])).toMatchObject({ basis: "Water", rate: 0.2, per_base: 100 });
  });
  it("without one it stays on Water at the tank mix's own rate, keeping the water range", () => {
    const c = withRateRows(chem, [water]);
    expect(c).toMatchObject({ basis: "Water", rate: 2, lower: 0.5, upper: 1 });
    expect(rateOutOfRange(c)).toBe(true);
    expect(withRateRows(chem, undefined)).toMatchObject({ basis: "Water", rate: 2 });
  });
  it("one-sided ranges use the side that is set", () => {
    expect(defaultRate({ lower: 0, upper: 5 })).toBe(5);
    expect(defaultRate({ lower: 1.5, upper: 0 })).toBe(1.5);
  });
  it("the payload carries the absolute quantity, area-based for Hectarage", () => {
    const p = toDraftPayload(blk("P1-B1 - MUT"), {
      ...emptyPlan(), water: "2500", classification: "Curative", team: "T", bom: "B", targets: ["Thrips"],
      chemicals: [{ ...chem, basis: "Hectarage", rate: 3 }, { ...chem, item_code: "Y", rate: 2 }],
    }, 2.5, "2026-10-30 06:00:00");
    expect(p.chemicals.map((c) => c.application_rate)).toEqual([7.5, 5]);
    expect(p.custom_water_volume).toBe(2500);
  });
});

describe("one plan per block (shared plan form)", () => {
  const S = "Chemical Store - MUT";
  const base = { ...emptyPlan(), classification: "Curative" as const, team: "T", targets: ["Thrips"], water: "1000" };
  const a = {
    ...base, bom: "BOM-A", method: "Dusting", scheduledAt: "2026-11-27 05:30:00",
    chemicals: [{ item_code: "X", item_name: "X", stock_uom: "Litre", basis: "Water" as const, rate: 2, source: S, batch_no: "B-1", batch_required: true }],
  };
  const b = {
    ...base, bom: "BOM-B", scheduledAt: "2026-11-28 07:00:00",
    chemicals: [{ item_code: "X", item_name: "X", stock_uom: "Litre", basis: "Water" as const, rate: 3, source: S }],
  };

  it("two blocks make two drafts, each with its own tank mix, rows, batch, time and method", () => {
    const pa = toDraftPayload(blk("A - MUT"), a, 2, "2026-11-26 06:00:00");
    const pb = toDraftPayload(blk("B - MUT"), b, 2, "2026-11-26 06:00:00");
    expect(pa).toMatchObject({ custom_greenhouse: "A - MUT", production_item: "BOM-A", custom_method_of_application: "Dusting", custom_scheduled_application_time: "2026-11-27 05:30:00" });
    expect(pb).toMatchObject({ custom_greenhouse: "B - MUT", production_item: "BOM-B", custom_method_of_application: "Spraying (foliar)", custom_scheduled_application_time: "2026-11-28 07:00:00" });
    expect(pa.chemicals[0]).toMatchObject({ item_code: "X", batch_no: "B-1", application_rate: 2 });
    expect(pb.chemicals[0]).toMatchObject({ item_code: "X", batch_no: null, application_rate: 3 });
  });

  it("a plan with no time of its own goes out at the planner's default", () => {
    expect(toDraftPayload(blk("A - MUT"), { ...a, scheduledAt: "" }, 2, "2026-11-26 06:00:00").custom_scheduled_application_time).toBe("2026-11-26 06:00:00");
  });

  it("a batch-tracked row with no batch blocks only its own block, in the roses words", () => {
    const noBatch = { ...a, chemicals: [{ ...a.chemicals[0], batch_no: undefined }] };
    expect(planProblems(noBatch, 2)).toContain("a batch for X");
    expect(planProblems(a, 2)).toEqual([]);
    expect(planProblems(b, 2)).toEqual([]);
  });

  it("a block's Available nets off what the other selected blocks draw from the same store", () => {
    const blocks = [blk("A - MUT"), blk("B - MUT"), blk("C - MUT", { farm: "Other" })];
    const c = { ...b, chemicals: [{ ...b.chemicals[0], source: "Other Store" }] };
    expect(usageByStore(a, 2)).toEqual({ [`${S}::X`]: 2 });
    const plans = { "A - MUT": a, "B - MUT": b, "C - MUT": c };
    expect(reservedElsewhere("B - MUT", blocks, plans)).toEqual({ [`${S}::X`]: 2, "Other Store::X": 3 });
    expect(reservedElsewhere("A - MUT", blocks, plans)[`${S}::X`]).toBe(3);
  });

  it("a block with no area: an Area row has no quantity and the plan asks for the area, never NaN", () => {
    const area = { ...a, chemicals: [{ ...a.chemicals[0], basis: "Hectarage" as const, rate: 1 }] };
    expect(chemicalQty(area.chemicals[0], 0, 1000)).toBe(0);
    expect(planProblems(area, 0)).toContain("the block area");
    expect(Number.isNaN(toDraftPayload(blk("A - MUT", { area_ha: 0 }), area, 0, "x").chemicals[0].application_rate)).toBe(false);
  });
});

describe("block crew", () => {
  it("the crew picked under the team pill rides on the draft as the plan's team members", () => {
    const p = toDraftPayload(blk("A - MUT"), { ...emptyPlan(), team: "T", members: [{ employee: "E1", employee_name: "Jane", role: "Supervisor" }] }, 1, "x");
    expect(p.custom_spray_plan_team_members).toEqual([{ employee: "E1", role: "Supervisor" }]);
    expect(toDraftPayload(blk("A - MUT"), emptyPlan(), 1, "x").custom_spray_plan_team_members).toBeUndefined();
  });
});

describe("stock gate (roses rule) on blocks", () => {
  const S = "Chemical Store - MUT";
  const row = (rate: number, over = {}) => ({ item_code: "X", item_name: "Xchem", stock_uom: "Litre", basis: "Water" as const, rate, source: S, stock_free: 10, ...over });
  const plan = (rate: number) => ({ ...emptyPlan(), classification: "Curative" as const, team: "T", bom: "B", targets: ["Thrips"], water: "1000", chemicals: [row(rate)] });

  it("a row needing more than its free stock, less the other blocks' draw, blocks its block", () => {
    expect(shortStockRows(plan(12), 2)).toEqual([{ name: "Xchem", source: S, avail: 10, need: 12 }]);
    expect(planProblems(plan(12), 2)).toContain("stock for Xchem");
    // 8 fits alone, but not once another selected block draws 3 of the same item there
    expect(planProblems(plan(8), 2)).toEqual([]);
    expect(planProblems(plan(8), 2, { [`${S}::X`]: 3 })).toContain("stock for Xchem");
  });

  it("lowering the quantity unblocks it", () => {
    expect(planProblems(plan(5), 2, { [`${S}::X`]: 3 })).toEqual([]);
  });

  it("stock not known yet is not judged; a row with no source is short", () => {
    expect(shortStockRows({ ...plan(50), chemicals: [row(50, { stock_free: undefined })] }, 2)).toEqual([]);
    expect(shortStockRows({ ...plan(1), chemicals: [row(1, { source: "", balances: {} })] }, 2)).toHaveLength(1);
  });
});
