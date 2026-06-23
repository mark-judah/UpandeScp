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
