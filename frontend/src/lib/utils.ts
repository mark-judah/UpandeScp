import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(n: number, opts?: Intl.NumberFormatOptions) {
  if (n == null || Number.isNaN(n)) return "0";
  return new Intl.NumberFormat(undefined, opts).format(n);
}

export function formatPercent(n: number, digits = 0) {
  if (n == null || Number.isNaN(n)) return "0%";
  return `${n.toFixed(digits)}%`;
}

export function isoWeek(date: Date): number {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export function ymd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

const DEFAULT_TIME = "06:00";

/**
 * Split a scheduled-application datetime string into its date and HH:mm parts.
 * Accepts a full ``YYYY-MM-DD HH:mm:ss`` string or a bare ``YYYY-MM-DD``.
 * Missing/blank time defaults to the spray-start default (06:00).
 */
export function splitDateTime(value: string): { date: string; time: string } {
  if (!value) return { date: "", time: DEFAULT_TIME };
  const [datePart, timePart] = value.split(" ");
  const time = timePart ? timePart.slice(0, 5) : DEFAULT_TIME;
  return { date: datePart || "", time: time || DEFAULT_TIME };
}

/**
 * Merge a ``YYYY-MM-DD`` date and an ``HH:mm`` time into the wire format
 * ``YYYY-MM-DD HH:mm:00``. Seconds are always forced to ``00``. Returns an
 * empty string when no date is set; falls back to 06:00 when no time is set.
 */
export function mergeDateTime(date: string, time: string): string {
  if (!date) return "";
  const hhmm = (time || DEFAULT_TIME).slice(0, 5);
  return `${date} ${hhmm}:00`;
}

/** Today's date merged with the given ``HH:mm`` time, e.g. "2026-07-22 06:00:00". */
export function todayAt(time: string): string {
  return mergeDateTime(ymd(new Date()), time);
}

/**
 * Convert a 24h ``HH:mm`` into its 12-hour parts. ``hour12`` is zero-padded
 * ("01".."12"); midnight/noon map to "12".
 */
export function to12h(hhmm: string): {
  hour12: string;
  minute: string;
  meridiem: "AM" | "PM";
} {
  const [h, m] = (hhmm || "06:00").split(":").map(Number);
  const hh = Number.isFinite(h) ? h : 6;
  const mm = Number.isFinite(m) ? m : 0;
  const meridiem: "AM" | "PM" = hh < 12 ? "AM" : "PM";
  let h12 = hh % 12;
  if (h12 === 0) h12 = 12;
  const pad = (n: number) => String(n).padStart(2, "0");
  return { hour12: pad(h12), minute: pad(mm), meridiem };
}

/** Build a 24h ``HH:mm`` from 12-hour parts. */
export function from12h(
  hour12: number,
  minute: number,
  meridiem: "AM" | "PM",
): string {
  let h = hour12 % 12; // 12 -> 0
  if (meridiem === "PM") h += 12; // 12PM -> 12, 1PM -> 13
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(minute)}`;
}

/** Human 12-hour readout for a 24h ``HH:mm``, e.g. "6:30 AM", "1:05 PM". */
export function format12h(hhmm: string): string {
  const { hour12, minute, meridiem } = to12h(hhmm);
  return `${Number(hour12)}:${minute} ${meridiem}`;
}

/**
 * Step an ``HH:mm`` time by one unit. Minutes move by ``minuteStep`` (default 5)
 * and carry into the hour like a real clock; hours wrap 23 <-> 00. ``dir`` is
 * ``+1`` (up) or ``-1`` (down). Returns a zero-padded ``HH:mm`` string.
 */
export function stepTime(
  value: string,
  field: "hour" | "minute",
  dir: 1 | -1,
  minuteStep = 5,
): string {
  const [hRaw, mRaw] = (value || "06:00").split(":").map(Number);
  let h = Number.isFinite(hRaw) ? hRaw : 6;
  let m = Number.isFinite(mRaw) ? mRaw : 0;
  if (field === "hour") {
    h = (h + dir + 24) % 24;
  } else {
    let total = h * 60 + m + dir * minuteStep;
    total = ((total % 1440) + 1440) % 1440; // wrap within a day
    h = Math.floor(total / 60);
    m = total % 60;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}`;
}

/** {from, to} for the current ISO week (Monday → Sunday). */
export function currentWeekRange(): { from: string; to: string } {
  const mon = new Date();
  const wd = (mon.getDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  mon.setDate(mon.getDate() - wd);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { from: ymd(mon), to: ymd(sun) };
}

/** [from, to] spanning the last ``months`` calendar months up to today. Used
 *  by sparse crops (e.g. avocado) whose crop-scoped fetch is cheap enough to
 *  default to a long window. */
export function lastMonthsRange(months: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setMonth(from.getMonth() - months);
  return { from: ymd(from), to: ymd(to) };
}
