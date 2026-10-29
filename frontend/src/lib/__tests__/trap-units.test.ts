import { describe, expect, it } from "vitest";
import { trapUnitLayers } from "../trap-units";
import type { TrapLocations } from "../scouting-api";

const hex = { type: "Polygon", coordinates: [[[36, 0], [36.1, 0], [36.1, 0.1], [36, 0.1], [36, 0]]] };
const LOCS: TrapLocations = {
  "Mutara - T01": { lat: 0.05, lng: 36.05, source: "Unit", fixes: 0, spread_m: 0, flag: "", trap_number: "T01", unit_type: "Triad", unit: "P1-B1 - Row 1 - Triad 1", unit_geometry: hex },
  "Mutara - T02": { lat: 0.5, lng: 36.5, source: "Unit", fixes: 0, spread_m: 0, flag: "", trap_number: "T02", unit_type: "Orchard Tree", unit: "Tree 1", unit_geometry: { type: "Point", coordinates: [36.5, 0.5] } },
  "Mutara - T03": { lat: 0.7, lng: 36.7, source: "Unit", fixes: 0, spread_m: 0, flag: "", trap_number: "T03", unit_type: "Bed", unit: "Row 4", unit_geometry: { type: "LineString", coordinates: [[36.7, 0.7], [36.8, 0.7]] } },
  "Mutara - T04": { lat: 0.9, lng: 36.9, source: "Manual", fixes: 0, spread_m: 0, flag: "" },
};

describe("trapUnitLayers", () => {
  it("outlines each trap's unit: the hexagon, the bed line; a tree or a bare trap is a ring at its point", () => {
    const { outlines, rings } = trapUnitLayers(LOCS);
    expect(outlines.features.map((f: any) => [f.properties.trap, f.geometry.type])).toEqual([
      ["Mutara - T01", "Polygon"],
      ["Mutara - T03", "LineString"],
    ]);
    expect(rings.features.map((f: any) => [f.properties.trap, f.geometry.coordinates])).toEqual([
      ["Mutara - T02", [36.5, 0.5]],
      ["Mutara - T04", [36.9, 0.9]],
    ]);
  });
  it("labels every trap with its number at the trap's point (the unit's centre)", () => {
    const { labels } = trapUnitLayers(LOCS);
    const byTrap = Object.fromEntries(labels.features.map((f: any) => [f.properties.trap, f]));
    expect(byTrap["Mutara - T01"].properties.label).toBe("T01");
    expect(byTrap["Mutara - T01"].geometry.coordinates).toEqual([36.05, 0.05]);
    // no trap number: the name's last part
    expect(byTrap["Mutara - T04"].properties.label).toBe("T04");
  });
  it("tints the outline with the trap's pest colour when it caught something", () => {
    const { outlines } = trapUnitLayers(LOCS, { "Mutara - T01": "#3366cc" });
    expect((outlines.features[0].properties as any).c).toBe("#3366cc");
    expect((outlines.features[1].properties as any).c).toBe("#3a3a34");
  });
});

describe("trapPlacement", () => {
  it("names the unit a trap hangs on, else how it was placed", async () => {
    const { trapPlacement } = await import("../trap-units");
    expect(trapPlacement(LOCS["Mutara - T01"])).toBe("On hexagon P1-B1 - Row 1 - Triad 1");
    expect(trapPlacement(LOCS["Mutara - T02"])).toBe("On tree Tree 1");
    expect(trapPlacement(LOCS["Mutara - T03"])).toBe("On bed Row 4");
    expect(trapPlacement(LOCS["Mutara - T04"])).toBe("Fixed · placed manually");
    expect(trapPlacement(undefined)).toBe("Average of entries");
  });
});
