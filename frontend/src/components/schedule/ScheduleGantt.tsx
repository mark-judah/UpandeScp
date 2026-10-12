import { useMemo } from "react";
import { format } from "date-fns";
import { AlertTriangle, ChevronsLeft } from "lucide-react";
import type { ScheduleLeave, SchedulePlan } from "@/lib/schedule-api";
import { cn } from "@/lib/utils";
import { Bar } from "@/components/Loading";
import { CrewPopover, hasUnavailable } from "./CrewPopover";
import { chipProps } from "./schedule-colors";
import { colOf, daysOf, overlaps, packLanes, startsBefore, ymd } from "./schedule-utils";
import { shortHouse } from "@/lib/places";

export type GanttRowsBy = "greenhouse" | "team";

const HEAD_W = 168;
const COL_W = 34;
const LANE_H = 28;

const HATCH_APPROVED =
  "repeating-linear-gradient(135deg, rgba(220,38,38,0.32) 0 5px, rgba(220,38,38,0.08) 5px 10px)";
const HATCH_PENDING =
  "repeating-linear-gradient(135deg, rgba(217,119,6,0.28) 0 5px, rgba(217,119,6,0.06) 5px 10px)";

/**
 * Rows are greenhouses or teams; columns are days. Plan bars run planned start →
 * actual end (one day when not ended). In team rows, each member's leave shows as a
 * hatched bar beneath the team, labelled with the person.
 */
export function ScheduleGantt({
  plans,
  leaves,
  from,
  to,
  rowsBy,
  today = new Date(),
  loading = false,
  onOpen,
}: {
  plans: SchedulePlan[];
  leaves: ScheduleLeave[];
  from: string;
  to: string;
  rowsBy: GanttRowsBy;
  today?: Date;
  /** first load: the real day header with pulsing rows beneath it */
  loading?: boolean;
  onOpen: (plan: SchedulePlan) => void;
}) {
  const days = useMemo(() => daysOf(from, to), [from, to]);
  const cols = `${HEAD_W}px repeat(${days.length}, ${COL_W}px)`;
  const width = HEAD_W + days.length * COL_W;

  const rows = useMemo(() => {
    const groups = new Map<string, SchedulePlan[]>();
    for (const p of plans) {
      if (!p.start) continue;
      const key = rowsBy === "team" ? p.team : p.greenhouse;
      groups.set(key, [...(groups.get(key) || []), p]);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([key, list]) => ({
        key,
        label: rowsBy === "team" ? key : shortHouse(key, list[0]?.farm),
        lanes: packLanes(list, (p) => [
          colOf(p.start!, from, to),
          colOf(p.end || p.start!, from, to),
        ]),
        leaves:
          rowsBy === "team"
            ? leaves.filter(
                (lv) => lv.teams.includes(key) && overlaps(lv.from_date, lv.to_date, from, to),
              )
            : [],
      }));
  }, [plans, leaves, rowsBy, from, to]);

  const todayKey = ymd(today);
  const todayCol = todayKey >= from && todayKey <= to ? colOf(todayKey, from, to) : -1;

  return (
    <div
      className="overflow-x-auto rounded-xl border bg-card"
      data-testid="schedule-gantt"
      aria-busy={loading || undefined}
    >
      <div className="relative" style={{ width }}>
        {todayCol >= 0 && (
          <div
            data-testid="gantt-today"
            className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-primary"
            style={{ left: HEAD_W + todayCol * COL_W + COL_W / 2 }}
          />
        )}
        {/* day header */}
        <div className="grid border-b bg-muted/40" style={{ gridTemplateColumns: cols }}>
          <div className="sticky left-0 z-10 bg-muted px-2 py-1.5 text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
            {rowsBy === "team" ? "Team" : "Greenhouse"}
          </div>
          {days.map((d) => (
            <div
              key={ymd(d)}
              className={cn(
                "py-1 text-center text-[0.6rem] leading-tight tabular-nums text-muted-foreground",
                (d.getDay() === 0 || d.getDay() === 6) && "bg-muted/60",
              )}
            >
              <div className="font-semibold text-foreground/80">{format(d, "d")}</div>
              <div>{format(d, "EEEEE")}</div>
            </div>
          ))}
        </div>

        {loading &&
          rows.length === 0 &&
          [0, 1, 2, 3, 4, 5].map((r) => {
            // Bars staggered across the range, each a few days long.
            const start = Math.min((r * 5) % Math.max(1, days.length), Math.max(0, days.length - 3));
            const span = Math.min(2 + (r % 3), days.length - start);
            return (
              <div
                key={r}
                aria-hidden
                data-skeleton="row"
                className="grid border-b"
                style={{ gridTemplateColumns: cols, gridTemplateRows: `${LANE_H}px` }}
              >
                <div className="sticky left-0 z-10 flex items-center bg-card px-2">
                  <Bar className="h-3 w-24" />
                </div>
                {/* `Bar` takes classes only, and this one needs a grid column. */}
                {span > 0 && (
                  <span
                    className="mx-0.5 my-1 block animate-pulse rounded-md bg-[var(--sd-bg-soft)]"
                    style={{ gridRow: 1, gridColumn: `${start + 2} / ${start + span + 2}` }}
                  />
                )}
              </div>
            );
          })}

        {rows.map((row) => {
          const laneCount = Math.max(1, ...row.lanes.map((l) => l.lane + 1));
          return (
            <div key={row.key} data-testid="gantt-row" className="border-b">
              <div
                className="grid"
                style={{ gridTemplateColumns: cols, gridTemplateRows: `repeat(${laneCount}, ${LANE_H}px)` }}
              >
                <div
                  className="sticky left-0 z-10 flex items-center truncate bg-card px-2 text-[0.72rem] font-semibold"
                  style={{ gridRow: `1 / span ${laneCount}`, gridColumn: 1 }}
                  title={row.key}
                >
                  {row.label}
                </div>
                {row.lanes.map(({ item: p, lane }) => {
                  const s = colOf(p.start!, from, to);
                  const e = colOf(p.end || p.start!, from, to);
                  // Began before the range: the bar is clipped at the left edge (square
                  // corner, no margin) with a chevron saying it continues.
                  const clipped = startsBefore(p, from);
                  const paint = chipProps(p.workflow_state);
                  const short = hasUnavailable(p);
                  return (
                    <div
                      key={p.name}
                      data-testid="gantt-bar"
                      data-clipped={clipped ? "start" : undefined}
                      data-unavailable={short ? "true" : undefined}
                      title={`${p.name} · ${p.greenhouse} · ${p.team} · ${p.workflow_state}${clipped ? ` · continues from ${p.start!.slice(0, 10)}` : ""}`}
                      className={cn(
                        "mx-0.5 my-1 flex min-w-0 items-center gap-1 overflow-hidden rounded-md px-1 text-[0.62rem] font-semibold",
                        clipped && "ml-0 rounded-l-none pl-0.5",
                        paint.className,
                        short && "ring-2 ring-inset ring-red-500/70",
                      )}
                      style={{ ...paint.style, gridRow: lane + 1, gridColumn: `${s + 2} / ${e + 3}` }}
                    >
                      <button
                        type="button"
                        onClick={() => onOpen(p)}
                        className="flex min-w-0 flex-1 items-center gap-1 text-left hover:underline"
                      >
                        {clipped && <ChevronsLeft className="h-3 w-3 shrink-0" />}
                        <span className="truncate">
                          {rowsBy === "team" ? shortHouse(p.greenhouse, p.farm) : p.team}
                        </span>
                        {p.on_leave_count > 0 && (
                          <AlertTriangle
                            data-testid="leave-warning"
                            className="h-3 w-3 shrink-0 text-red-700 dark:text-red-300"
                          />
                        )}
                      </button>
                      <CrewPopover plan={p} compact={e - s < 3} onOpenPlan={() => onOpen(p)} />
                    </div>
                  );
                })}
              </div>
              {row.leaves.map((lv) => {
                const s = colOf(lv.from_date, from, to);
                const e = colOf(lv.to_date, from, to);
                return (
                  <div
                    key={`${row.key}-${lv.name}`}
                    className="grid"
                    style={{ gridTemplateColumns: cols, gridTemplateRows: "22px" }}
                  >
                    <div className="sticky left-0 z-10 truncate bg-card px-2 pl-4 text-[0.62rem] leading-[22px] text-muted-foreground">
                      {lv.employee_name}
                    </div>
                    <div
                      data-testid="gantt-leave"
                      data-status={lv.status}
                      title={`${lv.employee_name}: ${lv.leave_type || "Leave"} ${lv.from_date} → ${lv.to_date}${lv.status === "pending" ? " (pending approval)" : ""}`}
                      className="mx-0.5 my-0.5 truncate rounded px-1 text-[0.58rem] font-medium leading-[18px] text-foreground/80"
                      style={{
                        gridColumn: `${s + 2} / ${e + 3}`,
                        backgroundImage: lv.status === "pending" ? HATCH_PENDING : HATCH_APPROVED,
                      }}
                    >
                      {lv.employee_name}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
