import { useMemo } from "react";
import { format, isSameDay } from "date-fns";
import { AlertTriangle, ChevronsLeft } from "lucide-react";
import type { SchedulePlan } from "@/lib/schedule-api";
import { cn } from "@/lib/utils";
import { CrewPopover, hasUnavailable } from "./CrewPopover";
import { chipProps } from "./schedule-colors";
import { calendarDayOf, calendarDays, shortGreenhouse, startsBefore, ymd } from "./schedule-utils";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Month or week grid; each day lists its plans as chips coloured by state. */
export function ScheduleCalendar({
  plans,
  from,
  to,
  today = new Date(),
  onOpen,
}: {
  plans: SchedulePlan[];
  from: string;
  to: string;
  today?: Date;
  onOpen: (plan: SchedulePlan) => void;
}) {
  const days = useMemo(() => calendarDays(from, to), [from, to]);
  const byDay = useMemo(() => {
    const m = new Map<string, SchedulePlan[]>();
    for (const p of plans) {
      if (!p.start) continue;
      // A plan that began before the visible range but runs into it shows on the
      // first visible day, marked as continuing.
      const k = calendarDayOf(p, from);
      if (k === null) continue;
      m.set(k, [...(m.get(k) || []), p]);
    }
    return m;
  }, [plans, from]);

  return (
    <div className="overflow-x-auto rounded-xl border bg-card" data-testid="schedule-calendar">
      <div className="grid min-w-[720px] grid-cols-7">
        {WEEKDAYS.map((w) => (
          <div
            key={w}
            className="border-b bg-muted/40 px-2 py-1.5 text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {w}
          </div>
        ))}
        {days.map((d) => {
          const key = ymd(d);
          const inRange = key >= from && key <= to;
          const list = byDay.get(key) || [];
          return (
            <div
              key={key}
              data-testid={`cal-day-${key}`}
              className={cn(
                "min-h-[96px] border-b border-r p-1.5",
                !inRange && "bg-muted/30 text-muted-foreground/60",
              )}
            >
              <div
                className={cn(
                  "mb-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[0.68rem] tabular-nums",
                  isSameDay(d, today) && "bg-primary text-primary-foreground font-semibold",
                )}
              >
                {format(d, "d")}
              </div>
              <div className="flex flex-col gap-1">
                {list.map((p) => {
                  const paint = chipProps(p.workflow_state);
                  const short = hasUnavailable(p);
                  return (
                    <div
                      key={p.name}
                      data-testid="cal-chip"
                      data-unavailable={short ? "true" : undefined}
                      className={cn(
                        "flex w-full flex-col gap-0.5 rounded-md px-1.5 py-1 text-[0.65rem] leading-tight",
                        paint.className,
                        short && "ring-2 ring-red-500/70",
                      )}
                      style={paint.style}
                    >
                      <button
                        type="button"
                        onClick={() => onOpen(p)}
                        title={`${p.name} · ${p.greenhouse} · ${p.team} · ${p.workflow_state}${startsBefore(p, from) ? ` · continues from ${p.start!.slice(0, 10)}` : ""}`}
                        className="flex w-full items-center gap-1 text-left hover:underline"
                      >
                        {startsBefore(p, from) && (
                          <ChevronsLeft
                            data-testid="cal-continues"
                            aria-label={`continues from ${p.start!.slice(0, 10)}`}
                            className="h-3 w-3 shrink-0"
                          />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-semibold">
                            {shortGreenhouse(p.greenhouse, p.farm)}
                          </span>
                          <span className="block truncate">{p.team}</span>
                        </span>
                        {p.on_leave_count > 0 && (
                          <span
                            data-testid="leave-warning"
                            className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-red-700 px-1 text-[0.58rem] font-bold text-white"
                            title={`${p.on_leave_count} crew member(s) on approved leave`}
                          >
                            <AlertTriangle className="h-2.5 w-2.5" />
                            {p.on_leave_count}
                          </span>
                        )}
                      </button>
                      <CrewPopover plan={p} onOpenPlan={() => onOpen(p)} />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
