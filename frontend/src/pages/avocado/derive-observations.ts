import type { ProcessedData } from "@/lib/scouting-types";
import { type ObsKind } from "@/lib/observation-colors";

/** Observation names of the given kind on one entry, with a count (diseases
 *  carry no count, so each counts once). */
function obsOf(e: ProcessedData["entries"][number], kind: ObsKind): Array<{ name: string; count: number }> {
  if (kind === "pest")
    return (e.pests_scouting_entry || []).map((o) => ({ name: o.pest, count: o.count || 1 }));
  return (e.diseases_scouting_entry || []).map((o) => ({ name: o.disease, count: 1 }));
}

/** tree → canonical colour of its DOMINANT observation of `kind`.
 *  `colorOf` resolves an observation name to a hex (pestColor / diseaseColor). */
export function deriveObservationColors(
  data: ProcessedData | null,
  kind: ObsKind,
  colorOf: (name: string) => string,
): Map<string, string> {
  const m = new Map<string, string>();
  if (!data) return m;
  const perTree = new Map<string, Map<string, number>>();
  for (const e of data.entries) {
    if (!e.tree) continue;
    for (const o of obsOf(e, kind)) {
      if (!o.name) continue;
      let t = perTree.get(e.tree);
      if (!t) {
        t = new Map();
        perTree.set(e.tree, t);
      }
      t.set(o.name, (t.get(o.name) || 0) + o.count);
    }
  }
  for (const [tree, names] of perTree) {
    let best = "";
    let bestN = -1;
    for (const [name, n] of names) if (n > bestN) { bestN = n; best = name; }
    m.set(tree, colorOf(best));
  }
  return m;
}

export interface ObsRosterRow {
  name: string;
  count: number;
}

/** Observation names of `kind` with total counts, most frequent first. */
export function deriveObservationRoster(
  data: ProcessedData | null,
  kind: ObsKind,
): ObsRosterRow[] {
  if (!data) return [];
  const totals = new Map<string, number>();
  for (const e of data.entries)
    for (const o of obsOf(e, kind))
      if (o.name) totals.set(o.name, (totals.get(o.name) || 0) + o.count);
  return Array.from(totals, ([name, count]) => ({ name, count })).sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
}
