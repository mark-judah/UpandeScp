/** Pure helpers for the Farm Structure mind map: layout, search, defaults. */
import type { StructureNode as Node, UnitInfo } from "./structure-api";

export const COL_W = 250;
export const ROW_H = 64;

export type LaidNode = { node: Node; x: number; y: number; depth: number };
export type Link = { from: string; to: string };

/**
 * Left-to-right tree: a node's column is its depth, leaves stack one row each,
 * a parent sits at the middle of its visible children. A node not in `expanded`
 * is drawn without its children.
 */
export function layoutTree(
  root: Node,
  expanded: Set<string>,
): { nodes: LaidNode[]; links: Link[] } {
  const nodes: LaidNode[] = [];
  const links: Link[] = [];
  let row = 0;
  const place = (node: Node, depth: number): number => {
    const kids = expanded.has(node.name) ? node.children : [];
    let y: number;
    const idx = nodes.length;
    nodes.push({ node, x: depth * COL_W, y: 0, depth });
    if (kids.length === 0) {
      y = row * ROW_H;
      row += 1;
    } else {
      const ys = kids.map((k) => {
        const ky = place(k, depth + 1);
        links.push({ from: node.name, to: k.name });
        return ky;
      });
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    nodes[idx].y = y;
    return y;
  };
  place(root, 0);
  return { nodes, links };
}

/** Names from the root to the first node whose label contains `query`. */
export function findPath(root: Node, query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const walk = (node: Node, trail: string[]): string[] => {
    const here = [...trail, node.name];
    if (node.label.toLowerCase().includes(q)) return here;
    for (const c of node.children) {
      const hit = walk(c, here);
      if (hit.length) return hit;
    }
    return [];
  };
  return walk(root, []);
}

/** The root and the first two levels open. */
export function defaultExpanded(root: Node): Set<string> {
  const out = new Set<string>();
  const walk = (node: Node, depth: number) => {
    if (depth > 1) return;
    out.add(node.name);
    node.children.forEach((c) => walk(c, depth + 1));
  };
  walk(root, 0);
  return out;
}

const PAIR: Record<string, [string, string]> = {
  Bed: ["Bed", "Zone"],
  Row: ["Row", "Tree"],
  Hexa: ["Hexa", "Triad"],
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "12 Hexas · 64 Triads (3 edge)" */
export function unitText(u: UnitInfo): string {
  const [a, b] = PAIR[u.kind] ?? [String(u.kind || "Unit"), "Child"];
  const base = `${plural(u.units, a)} · ${plural(u.children, b)}`;
  return u.edge > 0 ? `${base} (${u.edge} edge)` : base;
}
