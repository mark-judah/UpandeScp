/**
 * ISO 8601 week helpers for chart x-axes.
 *
 * `weekTickFormatter` returns "Week N" on ISO Mondays and "" everywhere
 * else, so recharts anchors a label at the start of each week while keeping
 * daily resolution between ticks.
 */

/** ISO 8601 week number for a given Date. Weeks start Monday; the first
 *  week of the year is the one containing Thursday. */
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** True if the given YYYY-MM-DD string is an ISO Monday. */
function isMonday(ymd: string): boolean {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return false;
  return new Date(y, m - 1, d).getDay() === 1;
}

/** Tick formatter for a date-string x-axis. Renders "Week N" on Mondays
 *  and an empty string on other days; pair with `interval={0}` on the
 *  XAxis so recharts evaluates every tick. */
export function weekTickFormatter(value: string): string {
  if (!value || typeof value !== "string") return "";
  if (!isMonday(value)) return "";
  const [y, m, d] = value.split("-").map(Number);
  return `Week ${isoWeek(new Date(y, m - 1, d))}`;
}

/** Tick formatter for an x-axis whose keys are already ISO-week LABELS
 *  ("2026-W29" → "Week 29"), as the Trends payload emits.
 *
 *  Kept separate from `weekTickFormatter`, which takes YYYY-MM-DD and is still
 *  used by seven daily-resolution dashboard charts. Feeding a week label to that
 *  one silently returns "" for every tick (Number("W29") is NaN), i.e. a blank
 *  axis rather than a visible error.
 *
 *  The year is dropped unless it differs from `refYear`, so a range spanning a
 *  year boundary stays unambiguous without repeating the year on every tick. */
export function weekLabelTickFormatter(value: string, refYear?: number): string {
  if (!value || typeof value !== "string") return "";
  const m = /^(\d{4})-W(\d{1,2})$/.exec(value);
  if (!m) return "";
  const year = Number(m[1]);
  const week = Number(m[2]);
  return refYear !== undefined && year !== refYear
    ? `W${week} '${String(year).slice(2)}`
    : `Week ${week}`;
}
