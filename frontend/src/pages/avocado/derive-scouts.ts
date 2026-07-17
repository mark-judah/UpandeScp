import type { ProcessedData } from "@/lib/scouting-types";

export const SCOUT_PALETTE = [
  "#2BA6E0", "#E66BAA", "#8466C7", "#E9A23B", "#5BB45D",
  "#3D54B0", "#E63946", "#10b981", "#f97316", "#a855f7",
];

/** tree → the colour of the scout who logged it (first-seen palette order). */
export function deriveScoutColors(data: ProcessedData | null): Map<string, string> {
  const m = new Map<string, string>();
  if (!data) return m;
  const scoutColors = new Map<string, string>();
  for (const e of data.entries) {
    if (!e.tree || !e.scouts_name) continue;
    let col = scoutColors.get(e.scouts_name);
    if (!col) {
      col = SCOUT_PALETTE[scoutColors.size % SCOUT_PALETTE.length];
      scoutColors.set(e.scouts_name, col);
    }
    m.set(e.tree, col);
  }
  return m;
}

export interface ScoutRosterRow {
  key: string;
  color: string;
  trees: number;
}

/** Scouts who logged trees, their colour and distinct trees, most active first. */
export function deriveScoutRoster(data: ProcessedData | null): ScoutRosterRow[] {
  const out: ScoutRosterRow[] = [];
  if (!data) return out;
  const color = new Map<string, string>();
  const trees = new Map<string, Set<string>>();
  for (const e of data.entries) {
    if (!e.tree || !e.scouts_name) continue;
    if (!color.has(e.scouts_name))
      color.set(e.scouts_name, SCOUT_PALETTE[color.size % SCOUT_PALETTE.length]);
    let s = trees.get(e.scouts_name);
    if (!s) {
      s = new Set();
      trees.set(e.scouts_name, s);
    }
    s.add(e.tree);
  }
  for (const [key, col] of color)
    out.push({ key, color: col, trees: trees.get(key)?.size || 0 });
  out.sort((a, b) => b.trees - a.trees || a.key.localeCompare(b.key));
  return out;
}
