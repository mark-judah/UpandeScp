/** Spray interventions between scouting weeks — pure helpers for the 3D playback.
 *  Data comes preloaded from `heatmap_interventions`, so nothing here fetches. */

import type { Reliability } from "@/lib/prevalence";

export interface Intervention {
  workOrder: string;
  date: string;
  chemicals: string[];
  ingredients: string[];
  moa: string[];
  targets: string[];
  sprayType?: string;
}

export interface WeekFigure {
  prevalence: number | null;
  margin?: number | null;
  reliability: Reliability | null;
  coverage?: number | null;
}

export interface WeekAccuracy extends WeekFigure {
  entries?: number | null;
  scouts?: number | null;
}

export interface InterventionInterval {
  fromWeek: string;
  toWeek: string;
  interventions: Intervention[];
  before: WeekFigure | null;
  after: WeekFigure | null;
  delta: number | null;
  direction: "better" | "worse" | "unchanged" | "unknown";
}

export interface InterventionPayload {
  weeks: Record<string, WeekAccuracy>;
  intervals: InterventionInterval[];
}

/** "2026-W40" -> "W40". */
export const weekShort = (w: string): string => w.replace(/^\d+-/, "");

/** Frame index -> intervals whose node sits right AFTER that frame (between it
 *  and the next). An interval belongs to the last frame whose week is <= its
 *  start week, so a spray in a week the pest vanished from (no frame) still
 *  lands in the right gap. Intervals starting before the first frame are dropped.
 *  Week labels sort lexicographically ("2026-W09" < "2026-W10"). */
export function placeNodes(
  frameWeeks: string[],
  intervals: InterventionInterval[] | undefined,
): Record<number, InterventionInterval[]> {
  const out: Record<number, InterventionInterval[]> = {};
  for (const iv of intervals ?? []) {
    let idx = -1;
    for (let i = 0; i < frameWeeks.length; i++) {
      if (frameWeeks[i] <= iv.fromWeek) idx = i;
    }
    if (idx < 0) continue;
    (out[idx] ??= []).push(iv);
  }
  return out;
}

const pts = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}`;

export interface CardContent {
  title: string;
  applied: string[];
  result: string;
  direction: InterventionInterval["direction"];
  reliabilityBefore: Reliability | null;
  reliabilityAfter: Reliability | null;
  counts: string | null;
}

/** What the playback card says. ``totals`` are the pest's observation counts per
 *  frame week (from the terrain data), for the severity/count change. */
export function cardContent(
  iv: InterventionInterval,
  obsName: string,
  totals?: Record<string, number>,
): CardContent {
  const applied = iv.interventions.map((e) => {
    const chem = e.chemicals.join(" + ") || "product not recorded";
    const detail = [
      e.ingredients.length ? e.ingredients.join(" + ") : null,
      e.moa.length ? e.moa.join(", ") : null,
    ].filter(Boolean);
    const target = e.targets.length ? e.targets.join(", ") : obsName || "all targets";
    return (
      `${chem}${detail.length ? ` (${detail.join("; ")})` : ""}` +
      ` applied on ${e.date} to target ${target}`
    );
  });
  let result: string;
  if (iv.before?.prevalence == null || iv.after?.prevalence == null || iv.delta == null) {
    result = "Result: no comparable scouting";
  } else {
    result =
      `Result: prevalence ${iv.before.prevalence}% → ${iv.after.prevalence}% ` +
      `(${pts(iv.delta)} pts, ${iv.direction})`;
  }
  const a = totals?.[iv.fromWeek];
  const b = totals?.[iv.toWeek];
  const counts =
    a !== undefined && b !== undefined
      ? `Observations ${Math.round(a)} → ${Math.round(b)} (${pts(Math.round(b - a))})`
      : null;
  return {
    title: `Between ${weekShort(iv.fromWeek)} and ${weekShort(iv.toWeek)}`,
    applied,
    result,
    direction: iv.direction,
    reliabilityBefore: iv.before?.reliability ?? null,
    reliabilityAfter: iv.after?.reliability ?? null,
    counts,
  };
}

/** One-line data-accuracy summary for a displayed week. */
export function accuracyLine(
  acc: WeekAccuracy | undefined,
  week: { coveragePct?: number | null; scouts?: unknown[]; zonesScouted?: number } | undefined,
): string {
  const parts: string[] = [];
  const cov = week?.coveragePct ?? acc?.coverage;
  if (cov != null) parts.push(`${Math.round(cov)}% covered`);
  if (week?.zonesScouted) parts.push(`${week.zonesScouted} zones`);
  const scouts = acc?.scouts ?? week?.scouts?.length;
  if (scouts) parts.push(`${scouts} scout${scouts === 1 ? "" : "s"}`);
  if (acc?.entries) parts.push(`${acc.entries} entries`);
  return parts.join(" · ");
}
