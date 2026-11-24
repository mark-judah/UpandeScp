import { describe, expect, it } from "vitest";
import { defaultExpanded, findPath, layoutTree, unitText } from "../structure-tree";
import type { StructureNode } from "../structure-api";

const n = (name: string, children: StructureNode[] = [], label = name): StructureNode => ({
  name, label, type: "T", children, unit: null, flags: [],
});

const root = n("F", [
  n("P1", [n("S1", [n("B1"), n("B2")]), n("S2", [n("B3")])], "Phase One"),
  n("P2", [n("S3", [n("B4")])]),
]);

describe("layoutTree", () => {
  it("drops the children of a collapsed node", () => {
    const { nodes } = layoutTree(root, new Set(["F", "P1", "S1"]));
    const names = nodes.map((x) => x.node.name);
    expect(names).toContain("S1");
    expect(names).toContain("B1");
    expect(names).toContain("P2");
    expect(names).not.toContain("S3"); // P2 collapsed
    expect(names).not.toContain("B3"); // S2 collapsed
  });
  it("never puts two nodes on one (x,y) and every link ends on a laid-out node", () => {
    const all = new Set(["F", "P1", "P2", "S1", "S2", "S3"]);
    const { nodes, links } = layoutTree(root, all);
    expect(new Set(nodes.map((x) => `${x.x},${x.y}`)).size).toBe(nodes.length);
    const ids = new Set(nodes.map((x) => x.node.name));
    for (const l of links) {
      expect(ids.has(l.from)).toBe(true);
      expect(ids.has(l.to)).toBe(true);
    }
    expect(links.length).toBe(nodes.length - 1);
  });
  it("lays out left to right by depth", () => {
    const { nodes } = layoutTree(root, new Set(["F", "P1"]));
    const by = Object.fromEntries(nodes.map((x) => [x.node.name, x]));
    expect(by.F.depth).toBe(0);
    expect(by.P1.x).toBeGreaterThan(by.F.x);
    expect(by.S1.x).toBeGreaterThan(by.P1.x);
  });
});

describe("findPath", () => {
  it("returns the ancestor chain, case-insensitive on label", () => {
    expect(findPath(root, "phase one")).toEqual(["F", "P1"]);
    expect(findPath(root, "b3")).toEqual(["F", "P1", "S2", "B3"]);
  });
  it("returns [] for no match or an empty query", () => {
    expect(findPath(root, "zzz")).toEqual([]);
    expect(findPath(root, "")).toEqual([]);
  });
});

describe("defaultExpanded", () => {
  it("holds the root and the first two levels only", () => {
    const e = defaultExpanded(root);
    expect([...e].sort()).toEqual(["F", "P1", "P2"]);
  });
});

describe("unitText", () => {
  it("does not crash on an unknown kind", () => {
    expect(unitText({ kind: "Band", units: 2, children: 0, edge: 0 })).toBe("2 Bands · 0 Childs");
  });

  it("names Hexa pairs and the edge count", () => {
    expect(unitText({ kind: "Hexa", units: 12, children: 64, edge: 3 })).toBe("12 Hexas · 64 Triads (3 edge)");
    expect(unitText({ kind: "Row", units: 1, children: 5, edge: 0 })).toBe("1 Row · 5 Trees");
    expect(unitText({ kind: "Bed", units: 2, children: 9, edge: 0 })).toBe("2 Beds · 9 Zones");
  });
});
