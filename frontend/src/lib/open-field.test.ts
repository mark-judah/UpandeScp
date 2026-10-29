import { describe, expect, it } from "vitest";
import {
  COLLAPSE_ABOVE,
  effectiveArea,
  emptyPlan,
  groupState,
  planProblems,
  shouldCollapse,
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
    chemicals: [{ item_code: "X", item_name: "X", stock_uom: "Litre", rate: 1, source: "Chemical Store - MUT" }],
  };

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
    expect(planProblems(ok, 0)).toContain("an area");
    const typed = { ...ok, area: "1.5" };
    expect(effectiveArea(blk("A - MUT", { area_ha: 0 }), typed)).toBe(1.5);
    expect(planProblems(typed, effectiveArea(blk("A - MUT", { area_ha: 0 }), typed))).toEqual([]);
  });
});

describe("payload", () => {
  it("is a one-block draft: block as greenhouse, area x 1000 L water, quantity = rate x litres / 1000", () => {
    const p = toDraftPayload(blk("P1-B1 - MUT"), {
      ...emptyPlan(),
      classification: "Curative",
      team: "Spray 1",
      bom: "BOM-1",
      kit: "Kit 1",
      targets: ["Thrips"],
      chemicals: [{ item_code: "X", item_name: "X", stock_uom: "Litre", rate: 2, source: "Chemical Store - MUT" }],
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
