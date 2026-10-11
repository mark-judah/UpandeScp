import {
  addDays,
  differenceInCalendarDays,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  parseISO,
  startOfMonth,
  startOfWeek,
} from "date-fns";

export const ymd = (d: Date) => format(d, "yyyy-MM-dd");
export const day = (s: string) => parseISO(s.slice(0, 10));

export function monthRange(anchor: Date): { from: string; to: string } {
  return { from: ymd(startOfMonth(anchor)), to: ymd(endOfMonth(anchor)) };
}

export function weekRange(anchor: Date): { from: string; to: string } {
  return {
    from: ymd(startOfWeek(anchor, { weekStartsOn: 1 })),
    to: ymd(endOfWeek(anchor, { weekStartsOn: 1 })),
  };
}

export function daysOf(from: string, to: string): Date[] {
  const a = day(from);
  const b = day(to);
  if (b < a) return [];
  return eachDayOfInterval({ start: a, end: b });
}

/** Column index (0-based) of a date inside [from, to], clamped to the range. */
export function colOf(date: string, from: string, to: string): number {
  const n = differenceInCalendarDays(day(to), day(from));
  const i = differenceInCalendarDays(day(date), day(from));
  return Math.max(0, Math.min(n, i));
}

export function overlaps(start: string, end: string, from: string, to: string): boolean {
  return start.slice(0, 10) <= to && end.slice(0, 10) >= from;
}

/** Greedy lane packing: items that overlap in days go on separate lanes. */
export function packLanes<T>(items: T[], span: (t: T) => [number, number]): Array<{ item: T; lane: number }> {
  const sorted = [...items].sort((a, b) => span(a)[0] - span(b)[0]);
  const laneEnds: number[] = [];
  return sorted.map((item) => {
    const [s, e] = span(item);
    let lane = laneEnds.findIndex((end) => end < s);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(e);
    } else {
      laneEnds[lane] = e;
    }
    return { item, lane };
  });
}

/** Calendar grid days: the range padded out to whole weeks (Mon–Sun). */
export function calendarDays(from: string, to: string): Date[] {
  const a = startOfWeek(day(from), { weekStartsOn: 1 });
  const b = endOfWeek(day(to), { weekStartsOn: 1 });
  return eachDayOfInterval({ start: a, end: b });
}

export { addDays };

/** Chip / bar colour by workflow state. Fills, never a left-border strip. */
export function stateTone(state: string): string {
  switch (state) {
    case "Pending Submission":
    case "Awaiting Approval":
      return "bg-amber-500/20 text-amber-900 dark:text-amber-200";
    case "Approved":
      return "bg-sky-500/20 text-sky-900 dark:text-sky-200";
    case "Chemical Issued":
    case "Chemicals Issued Direct":
      return "bg-indigo-500/20 text-indigo-900 dark:text-indigo-200";
    case "Tank Mix Manufactured":
      return "bg-violet-500/20 text-violet-900 dark:text-violet-200";
    case "Spraying In Progress":
      return "bg-emerald-500/30 text-emerald-900 dark:text-emerald-200";
    case "Completed":
      return "bg-green-600/15 text-green-900 dark:text-green-200";
    default:
      return "bg-slate-500/15 text-slate-800 dark:text-slate-200";
  }
}

export const STATE_LEGEND = [
  "Awaiting Approval",
  "Approved",
  "Chemical Issued",
  "Tank Mix Manufactured",
  "Spraying In Progress",
  "Completed",
];

/** "Chepsito GH 16 - KR" → "GH 16" for a chip; the full name stays in the title. */
export function shortGreenhouse(name: string, farm?: string | null): string {
  let s = (name || "").replace(/\s+-\s+[A-Z]{1,4}$/, "");
  if (farm && s.toLowerCase().startsWith(farm.toLowerCase() + " ")) s = s.slice(farm.length + 1);
  return s;
}

export function openPlan(name: string): void {
  window.open(`/app/work-order/${encodeURIComponent(name)}`, "_blank", "noopener");
}
