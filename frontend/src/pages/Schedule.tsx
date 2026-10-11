/**
 * Spray Schedule — the plans, their crews, and the crews' leave, in two views.
 *
 * * **Calendar**: a month or week grid; each day lists its plans as chips.
 * * **Gantt**: rows are greenhouses or teams, columns are days. In team rows each
 *   member's leave shows as a hatched bar beneath the team.
 *
 * A plan whose crew includes someone on approved leave on the plan date carries a
 * warning. Built on date-fns + CSS grid — no calendar library.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { addMonths, addWeeks } from "date-fns";
import { CalendarDays, ChevronLeft, ChevronRight, GanttChart, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScheduleCalendar } from "@/components/schedule/ScheduleCalendar";
import { ScheduleGantt, type GanttRowsBy } from "@/components/schedule/ScheduleGantt";
import {
  STATE_LEGEND,
  day,
  monthRange,
  openPlan,
  stateTone,
  weekRange,
} from "@/components/schedule/schedule-utils";
import { fetchSchedule, type Schedule as ScheduleData } from "@/lib/schedule-api";
import { errorText } from "@/lib/errors";
import { cn } from "@/lib/utils";

type ViewKind = "calendar" | "gantt";
type Span = "month" | "week";

const VIEW_KEY = "scp.schedule.view";
const ROWS_KEY = "scp.schedule.rows";

function readLocal<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = window.localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode / blocked storage: the toggle still works for this visit */
  }
}

const selectCls =
  "h-9 rounded-md border border-input bg-background px-2 text-sm min-w-0 max-w-full";

function Toggle<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string; icon?: ReactNode }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium",
            value === o.value ? "bg-background shadow-sm text-foreground" : "text-muted-foreground",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Schedule({ initialCrop }: { initialCrop?: string }) {
  const [view, setView] = useState<ViewKind>(() =>
    readLocal<ViewKind>(VIEW_KEY, ["calendar", "gantt"], "calendar"),
  );
  const [rowsBy, setRowsBy] = useState<GanttRowsBy>(() =>
    readLocal<GanttRowsBy>(ROWS_KEY, ["greenhouse", "team"], "greenhouse"),
  );
  const [span, setSpan] = useState<Span>("month");
  const [range, setRange] = useState(() => monthRange(new Date()));
  const [farm, setFarm] = useState("");
  const [team, setTeam] = useState("");
  const [state, setState] = useState("");
  const [data, setData] = useState<ScheduleData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Team options outlive a team-filtered response: picking a team must not leave it
  // as the only choice. Replaced by unfiltered responses, merged into by filtered ones.
  const [teamOptions, setTeamOptions] = useState<string[]>([]);
  // Stepping months quickly fires overlapping requests; only the newest may land.
  const requestId = useRef(0);

  const load = useCallback(() => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    fetchSchedule({ crop: initialCrop, farm, team, state, from_date: range.from, to_date: range.to })
      .then((r) => {
        if (id !== requestId.current) return;
        setData(r);
        setTeamOptions((prev) =>
          team ? [...new Set([...prev, ...(r.teams || [])])].sort() : [...(r.teams || [])],
        );
      })
      .catch((e) => {
        if (id !== requestId.current) return;
        setData(null);
        setError(errorText(e));
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [initialCrop, farm, team, state, range.from, range.to]);

  useEffect(() => {
    load();
  }, [load]);

  const changeView = (v: ViewKind) => {
    setView(v);
    writeLocal(VIEW_KEY, v);
  };
  const changeRows = (v: GanttRowsBy) => {
    setRowsBy(v);
    writeLocal(ROWS_KEY, v);
  };
  const changeSpan = (s: Span) => {
    setSpan(s);
    setRange(s === "week" ? weekRange(day(range.from)) : monthRange(day(range.from)));
  };
  const step = (dir: 1 | -1) => {
    const anchor = day(range.from);
    setRange(span === "week" ? weekRange(addWeeks(anchor, dir)) : monthRange(addMonths(anchor, dir)));
  };
  const jumpToLatest = () => {
    if (!data?.latest_plan_date) return;
    const anchor = day(data.latest_plan_date);
    setRange(span === "week" ? weekRange(anchor) : monthRange(anchor));
  };

  const plans = data?.plans || [];
  // The grid follows the range the server actually read (it may have been clamped).
  const shownFrom = data?.clamped ? data.from_date : range.from;
  const shownTo = data?.clamped ? data.to_date : range.to;
  const flagged = plans.filter((p) => p.on_leave_count > 0).length;

  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader
        title="Schedule"
        eyebrow={
          data
            ? `${plans.length} plan${plans.length === 1 ? "" : "s"} · ${flagged} with crew on leave · leave check ${data.leave_check}`
            : "Spray plans and crew leave"
        }
        switcher={
          <Toggle<ViewKind>
            label="View"
            value={view}
            onChange={changeView}
            options={[
              { value: "calendar", label: "Calendar", icon: <CalendarDays className="h-3.5 w-3.5" /> },
              { value: "gantt", label: "Gantt", icon: <GanttChart className="h-3.5 w-3.5" /> },
            ]}
          />
        }
      >
        <Button variant="outline" size="sm" onClick={load} disabled={loading} aria-label="Refresh">
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </PageHeader>

      <div className="flex min-w-0 flex-col gap-3 px-4 pb-6 md:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <Toggle<Span>
            label="Range"
            value={span}
            onChange={changeSpan}
            options={[
              { value: "month", label: "Month" },
              { value: "week", label: "Week" },
            ]}
          />
          <div className="inline-flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Previous" onClick={() => step(-1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Input
              type="date"
              aria-label="From"
              value={range.from}
              onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))}
              className="h-9 w-[9.5rem]"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              aria-label="To"
              value={range.to}
              onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))}
              className="h-9 w-[9.5rem]"
            />
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Next" onClick={() => step(1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <select aria-label="Farm" className={selectCls} value={farm} onChange={(e) => setFarm(e.target.value)}>
            <option value="">All farms</option>
            {(data?.farms || []).map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
          <select aria-label="Team" className={selectCls} value={team} onChange={(e) => setTeam(e.target.value)}>
            <option value="">All teams</option>
            {[...new Set([...teamOptions, ...(team ? [team] : [])])].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <select aria-label="State" className={selectCls} value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All states</option>
            {[...new Set([...STATE_LEGEND, ...(data?.states || [])])].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          {view === "gantt" && (
            <Toggle<GanttRowsBy>
              label="Rows"
              value={rowsBy}
              onChange={changeRows}
              options={[
                { value: "greenhouse", label: "Greenhouses" },
                { value: "team", label: "Teams" },
              ]}
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-[0.62rem]">
          {STATE_LEGEND.map((s) => (
            <span key={s} className={cn("rounded-full px-2 py-0.5 font-medium", stateTone(s))}>
              {s}
            </span>
          ))}
          {view === "gantt" && rowsBy === "team" && (
            <span className="text-muted-foreground">Hatched: crew leave (amber = pending)</span>
          )}
        </div>

        {data?.clamped && (
          <div
            role="status"
            data-testid="schedule-clamped"
            className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
          >
            Showing {data.from_date} to {data.to_date} — the schedule covers at most{" "}
            {data.max_range_days ?? 93} days at a time.
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {data && plans.length === 0 && !loading && (
          <div className="flex flex-col items-start gap-2 rounded-xl border bg-card px-4 py-6 text-sm">
            <span className="text-muted-foreground">No spray plans in this range.</span>
            {data.latest_plan_date && (
              <Button size="sm" variant="secondary" onClick={jumpToLatest}>
                Jump to latest plans ({data.latest_plan_date})
              </Button>
            )}
          </div>
        )}

        {data && plans.length > 0 &&
          (view === "calendar" ? (
            <ScheduleCalendar plans={plans} from={shownFrom} to={shownTo} onOpen={(p) => openPlan(p.name)} />
          ) : (
            <ScheduleGantt
              plans={plans}
              leaves={data.leaves}
              from={shownFrom}
              to={shownTo}
              rowsBy={rowsBy}
              onOpen={(p) => openPlan(p.name)}
            />
          ))}
      </div>
    </div>
  );
}
