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

/** True when a plan began before the visible range (it runs into it from the left). */
export function startsBefore(p: { start: string | null }, from: string): boolean {
  return !!p.start && p.start.slice(0, 10) < from;
}

/**
 * The calendar day a plan's chip goes on: its start, or the first visible day when it
 * began earlier and is still running inside the range. Null when it ended before it.
 */
export function calendarDayOf(p: { start: string | null; end: string | null }, from: string): string | null {
  if (!p.start) return null;
  const s = p.start.slice(0, 10);
  if (s >= from) return s;
  const e = (p.end || p.start).slice(0, 10);
  return e >= from ? from : null;
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

export const STATE_LEGEND = [
  "Awaiting Approval",
  "Approved",
  "Chemical Issued",
  "Tank Mix Manufactured",
  "Spraying In Progress",
  "Completed",
];


export function openPlan(name: string): void {
  window.open(`/app/work-order/${encodeURIComponent(name)}`, "_blank", "noopener");
}
