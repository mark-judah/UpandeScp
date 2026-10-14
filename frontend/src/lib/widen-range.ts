/**
 * "Widen the date range" hint for pages that show one week of data per card
 * (Heatmaps). Pure helpers so the wording and the arithmetic are testable.
 */
import { shortHouse } from "@/lib/places";

/** Weeks the "Widen" action reaches back. */
export const WIDEN_WEEKS = 12;

/** A range ending at `to` and starting `weeks` weeks earlier. Local dates. */
export function widenedRange(to: string, weeks: number = WIDEN_WEEKS): { from: string; to: string } {
  const [y, m, d] = to.split("-").map(Number);
  const end = new Date(y, (m || 1) - 1, d || 1);
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - weeks * 7);
  const f = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  return { from: f(start), to };
}

/** Days from `from` to `to`, inclusive. */
export function rangeDays(from: string, to: string): number {
  const t = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, (m || 1) - 1, d || 1);
  };
  return Math.round((t(to) - t(from)) / 86400000) + 1;
}

/** True when the range is already as wide as (or wider than) the widen action. */
export function isWideEnough(from: string, to: string, weeks: number = WIDEN_WEEKS): boolean {
  return rangeDays(from, to) >= weeks * 7;
}

/** "Kapkolia GH 15 · Spidermites": the houses and targets in view. */
export function targetLabel(houses: string[], targets: string[]): string {
  const clip = (xs: string[], n: number) =>
    xs.length <= n ? xs.join(", ") : `${xs.slice(0, n).join(", ")} +${xs.length - n}`;
  const h = clip(houses.map((x) => shortHouse(x)), 2);
  const t = clip(targets, 2);
  return [h, t].filter(Boolean).join(" · ");
}
