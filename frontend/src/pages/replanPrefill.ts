/** Re-plan prefill: the Approvals page's Stale tab links here with
 *  `#/<crop>/application-plan?replan=<WO>&greenhouse=..&date=..&target=..&item=..`
 *  (target and item repeat). Pure helpers; ApplicationPlan owns the state. */

export interface ReplanParams {
  replan: string;
  greenhouse: string;
  date: string;
  targets: string[];
  items: string[];
}

/** Parse the query part of a location hash; null when it is not a re-plan link. */
export function parseReplanParams(hash: string): ReplanParams | null {
  const q = hash.indexOf("?");
  if (q < 0) return null;
  const sp = new URLSearchParams(hash.slice(q + 1));
  const replan = (sp.get("replan") || "").trim();
  if (!replan) return null;
  const uniq = (xs: string[]) => Array.from(new Set(xs.map((x) => x.trim()).filter(Boolean)));
  return {
    replan,
    greenhouse: (sp.get("greenhouse") || "").trim(),
    date: (sp.get("date") || "").trim(),
    targets: uniq(sp.getAll("target")),
    items: uniq(sp.getAll("item")),
  };
}

export interface ReplanResolution {
  greenhouse: string;
  date: string;
  targets: string[];
  /** Human-readable "kind: value" entries that could not be matched. */
  skipped: string[];
}

/** Keep only what this site knows; list the rest. */
export function resolveReplan(
  p: ReplanParams,
  known: { greenhouses: string[]; targets: string[] },
): ReplanResolution {
  const skipped: string[] = [];
  let greenhouse = "";
  if (p.greenhouse) {
    if (known.greenhouses.includes(p.greenhouse)) greenhouse = p.greenhouse;
    else skipped.push(`greenhouse ${p.greenhouse}`);
  }
  const targets: string[] = [];
  for (const t of p.targets) {
    if (known.targets.includes(t)) targets.push(t);
    else skipped.push(`target ${t}`);
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : "";
  if (p.date && !date) skipped.push(`date ${p.date}`);
  return { greenhouse, date, targets, skipped };
}

export function pendingNote(n: number): string {
  return `${n} chemical${n === 1 ? "" : "s"} from the stale plan will be added when you pick a tank mix`;
}
