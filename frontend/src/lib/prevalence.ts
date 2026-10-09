/** Station prevalence figures as the dashboard aggregates send them — see
 *  upande_scp/serverscripts/common/prevalence.py. Every percentage is 0–100 with
 *  one decimal; the browser only formats them, it never recomputes. */
export type Reliability = "Good" | "Fair" | "Low";

export interface PrevalenceFigures {
  /** adjusted prevalence: section rates averaged (null = no stations set up) */
  prevalence: number | null;
  /** the same figure for the previous scouted week */
  prev?: number | null;
  /** 95% margin in percentage points; null = too clustered to judge */
  margin: number | null;
  /** sections (3 × 3 per house) with at least 3 stations scouted */
  sections_scouted: number;
  /** 9 per house; 9 × houses for a scope-wide figure */
  sections_total?: number;
  reliability: Reliability;
  reason?: string | null;
  raw?: number | null;
  coverage?: number | null;
  scouted?: number;
  stations?: number;
  week?: string | null;
}

export interface SectionCell {
  row: number;
  col: number;
  scouted: number;
  infested: number;
  /** null when fewer than 3 stations were scouted there ("not scouted") */
  pct: number | null;
}

export const CLUSTERED = "too clustered to judge";

/** "34% (was 50%) · ±6 · 8/9" — the one line the dashboard shows. */
export function figureLine(f: PrevalenceFigures): string {
  if (f.prevalence == null) return f.reason || "no stations set up";
  const was = f.prev != null ? ` (was ${f.prev}%)` : "";
  const margin = f.margin != null ? `±${f.margin}` : f.reason || CLUSTERED;
  return `${f.prevalence}%${was} · ${margin} · ${f.sections_scouted}/${f.sections_total ?? 9}`;
}

/** Hover text: what each of the four figures means, one line each. */
export function figureTooltip(f: PrevalenceFigures): string {
  return [
    "Prevalence: share of scouted stations carrying it, each part of the house counted equally (latest scouted week)",
    "Was: the same figure for the previous scouted week",
    "±: 95% margin, from how much the parts of the house disagree and how many stations were scouted",
    `${f.sections_scouted}/${f.sections_total ?? 9}: parts of the house (3 × 3 grid) with at least 3 stations scouted`,
  ].join("\n");
}
