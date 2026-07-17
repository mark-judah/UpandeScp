import type { OrchardTreePoints } from "./scouting-api";

/**
 * A row of orchard trees as sent by ``get_orchard_tree_rows``.
 *  - ``k:"l"`` LINEAR: interior trees are interpolated between endpoints ``a``/``b``.
 *  - ``k:"e"`` EXPLICIT: ``c`` holds every tree's [lng,lat] verbatim (obstacle rows).
 * Names are ``p + i`` (1-based) unless an explicit ``names`` array is given.
 */
export type OrchardTreeRow =
  | { k: "l"; p: string; a: [number, number]; b: [number, number]; n: number }
  | { k: "e"; c: number[]; n: number; p?: string; names?: string[] };

/** Expand rows into the flat ``{names, coords}`` the TreesLayer consumes. */
export function expandTreeRows(rows: OrchardTreeRow[]): OrchardTreePoints {
  const names: string[] = [];
  const coords: number[] = [];
  for (const row of rows) {
    if (row.k === "l") {
      const { p, a, b, n } = row;
      for (let i = 1; i <= n; i++) {
        const f = n === 1 ? 0 : (i - 1) / (n - 1);
        names.push(p + i);
        coords.push(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
      }
    } else {
      const { c, n } = row;
      for (let i = 1; i <= n; i++) {
        names.push(row.names ? row.names[i - 1] : (row.p || "") + i);
        coords.push(c[(i - 1) * 2], c[(i - 1) * 2 + 1]);
      }
    }
  }
  return { names, coords };
}
