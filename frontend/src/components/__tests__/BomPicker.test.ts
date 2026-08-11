import { describe, it, expect } from "vitest";
import { filterBoms, MAX_RENDERED_BOMS, type BomOption } from "../BomPicker";

const boms: BomOption[] = [
  { name: "BOM-Th/fcm-561", item_name: "Botrytis Mix", custom_farm: "Kaptumbo" },
  { name: "BOM-Th/fcm-902", item_name: "Botrytis Heavy", custom_farm: "Torongo" },
  { name: "BOM-Th/xyz-004", item_name: "Downy Mildew Mix", custom_farm: "Kaptumbo" },
  { name: "BOM-Th/xyz-005", item_name: null, custom_farm: null },
];

describe("filterBoms", () => {
  it("returns everything when the query is empty", () => {
    const { shown, matched } = filterBoms(boms, "");
    expect(matched).toBe(4);
    expect(shown).toHaveLength(4);
  });

  it("treats a whitespace-only query as empty", () => {
    expect(filterBoms(boms, "   ").matched).toBe(4);
  });

  it("matches on the mix name", () => {
    const { shown } = filterBoms(boms, "botrytis");
    expect(shown.map((b) => b.name)).toEqual(["BOM-Th/fcm-561", "BOM-Th/fcm-902"]);
  });

  it("matches on the BOM name, so operators can paste a BOM code", () => {
    const { shown } = filterBoms(boms, "fcm-902");
    expect(shown.map((b) => b.name)).toEqual(["BOM-Th/fcm-902"]);
  });

  it("matches on the farm", () => {
    const { shown } = filterBoms(boms, "kaptumbo");
    expect(shown.map((b) => b.name)).toEqual(["BOM-Th/fcm-561", "BOM-Th/xyz-004"]);
  });

  it("is case-insensitive in both directions", () => {
    expect(filterBoms(boms, "BOTRYTIS MIX").shown).toHaveLength(1);
    expect(filterBoms(boms, "torongo").shown).toHaveLength(1);
  });

  it("tolerates missing item_name / custom_farm without throwing", () => {
    expect(() => filterBoms(boms, "xyz-005")).not.toThrow();
    expect(filterBoms(boms, "xyz-005").shown.map((b) => b.name)).toEqual([
      "BOM-Th/xyz-005",
    ]);
  });

  it("caps what it renders but still reports the full match count", () => {
    const many: BomOption[] = Array.from({ length: 60 }, (_, i) => ({
      name: `BOM-${i}`,
      item_name: `Mix ${i}`,
      custom_farm: "Kaptumbo",
    }));
    const { shown, matched } = filterBoms(many, "mix", 50);
    expect(matched).toBe(60);
    expect(shown).toHaveLength(50);
  });

  it("defaults the cap to MAX_RENDERED_BOMS", () => {
    const many: BomOption[] = Array.from({ length: MAX_RENDERED_BOMS + 10 }, (_, i) => ({
      name: `BOM-${i}`,
      item_name: `Mix ${i}`,
    }));
    expect(filterBoms(many, "").shown).toHaveLength(MAX_RENDERED_BOMS);
  });

  it("returns nothing when the query matches nothing", () => {
    const { shown, matched } = filterBoms(boms, "nope-not-here");
    expect(shown).toEqual([]);
    expect(matched).toBe(0);
  });
});
