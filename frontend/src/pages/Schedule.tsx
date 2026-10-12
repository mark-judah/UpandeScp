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
import { CalendarDays, ChevronLeft, ChevronRight, GanttChart, RefreshCw, UsersRound } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/DatePicker";
import { FilterSelect } from "@/components/FilterSelect";
import { HeaderIconButton } from "@/components/header-controls";
import { ScheduleCalendar } from "@/components/schedule/ScheduleCalendar";
import { ScheduleGantt, type GanttRowsBy } from "@/components/schedule/ScheduleGantt";
import { ScoutPlanView } from "@/components/schedule/ScoutPlanView";
import { hasUnavailable } from "@/components/schedule/CrewPopover";
import { chipProps } from "@/components/schedule/schedule-colors";
import { STATE_LEGEND, day, monthRange, openPlan, weekRange } from "@/components/schedule/schedule-utils";
import { bootstrap } from "@/lib/frappe";
import { fetchSchedule, type Schedule as ScheduleData } from "@/lib/schedule-api";
import { errorText } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { TextSkeleton, firstLoad } from "@/components/Loading";

type ViewKind = "calendar" | "gantt" | "scouts";
type Span = "month" | "week";

const VIEW_KEY = "scp.schedule.view";
const UNAVAILABLE_KEY = "scp.schedule.unavailableOnly";

/** The spray views follow schedule.SCHEDULE_ROLES; the scout plan scout_plan.READ_ROLES. */
const SPRAY_ROLES = [
  "SCP Spray Plan Creator",
  "SCP Spray Plan Approver",
  "SCP Spray Supervisor",
  "SCP General Manager",
  "System Manager",
  "Administrator",
];
const SCOUT_ROLES = [...SPRAY_ROLES, "SCP Scouting User"];

function canSee(allowed: string[]): boolean {
  const b = bootstrap();
  // No bootstrap (tests, the dev server): show everything; the server still judges.
  if (!b.user) return true;
  return b.user === "Administrator" || b.roles.some((r) => allowed.includes(r));
}
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
  const sprayOk = canSee(SPRAY_ROLES);
  const scoutOk = canSee(SCOUT_ROLES);
  const [view, setView] = useState<ViewKind>(() => {
    const v = readLocal<ViewKind>(VIEW_KEY, ["calendar", "gantt", "scouts"], "calendar");
    return sprayOk ? (v === "scouts" && !scoutOk ? "calendar" : v) : "scouts";
  });
  const [unavailableOnly, setUnavailableOnly] = useState(
    () => readLocal(UNAVAILABLE_KEY, ["1", "0"], "0") === "1",
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
    if (view !== "scouts" && sprayOk) load();
  }, [load, view, sprayOk]);

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

  const allPlans = data?.plans || [];
  // "Show unavailable only" (C2): plans with someone not available on the plan date.
  const plans = unavailableOnly ? allPlans.filter(hasUnavailable) : allPlans;
  // The grid follows the range the server actually read (it may have been clamped).
  const shownFrom = data?.clamped ? data.from_date : range.from;
  const shownTo = data?.clamped ? data.to_date : range.to;
  const flagged = plans.filter((p) => p.on_leave_count > 0).length;
  // First load only (nothing yet, no error — `loading` is still false on the very
  // first paint, before the effect fires). A refresh keeps the old plans on screen.
  const skeleton = firstLoad(loading || (!data && !error), !!data);

  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader
        title="Schedule"
        eyebrow={
          view === "scouts"
            ? "Weekly scout plan"
            : data
              ? `${plans.length} plan${plans.length === 1 ? "" : "s"} · ${flagged} with crew on leave · leave check ${data.leave_check}`
              : skeleton && sprayOk
                ? <TextSkeleton width="18rem" />
                : "Spray plans and crew leave"
        }
        switcher={
          <Toggle<ViewKind>
            label="View"
            value={view}
            onChange={changeView}
            options={[
              ...(sprayOk
                ? [
                    { value: "calendar" as const, label: "Calendar", icon: <CalendarDays className="h-3.5 w-3.5" /> },
                    { value: "gantt" as const, label: "Gantt", icon: <GanttChart className="h-3.5 w-3.5" /> },
                  ]
                : []),
              ...(scoutOk
                ? [{ value: "scouts" as const, label: "Scout plan", icon: <UsersRound className="h-3.5 w-3.5" /> }]
                : []),
            ]}
          />
        }
      >
        {view !== "scouts" && (
          <>
            <FilterSelect
              label="Farm"
              allLabel="All farms"
              value={farm}
              onChange={setFarm}
              options={data?.farms || []}
              disabled={skeleton}
            />
            <FilterSelect
              label="Team"
              allLabel="All teams"
              value={team}
              onChange={setTeam}
              options={[...teamOptions, ...(team ? [team] : [])]}
              disabled={skeleton}
            />
            <FilterSelect
              label="State"
              allLabel="All states"
              value={state}
              onChange={setState}
              options={[...STATE_LEGEND, ...(data?.states || [])]}
            />
            <HeaderIconButton onClick={load} disabled={loading} aria-label="Refresh" tooltip="Reload the plans">
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </HeaderIconButton>
          </>
        )}
      </PageHeader>

      {view === "scouts" ? (
        <div className="flex min-w-0 flex-col gap-3 px-4 pb-6 md:px-6">
          <ScoutPlanView crop={initialCrop} initialFarm={farm} initialWeek={range.from} />
        </div>
      ) : (
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
            <DatePicker
              label="From"
              value={range.from}
              onChange={(v) => v && setRange((r) => ({ ...r, from: v }))}
            />
            <span className="text-xs text-muted-foreground">to</span>
            <DatePicker
              label="To"
              value={range.to}
              onChange={(v) => v && setRange((r) => ({ ...r, to: v }))}
            />
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Next" onClick={() => step(1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
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
          {STATE_LEGEND.map((s) => {
            const paint = chipProps(s);
            return (
              <span key={s} className={cn("rounded-full px-2 py-0.5 font-medium", paint.className)} style={paint.style}>
                {s}
              </span>
            );
          })}
          <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-xs text-foreground">
            <input
              type="checkbox"
              data-testid="unavailable-only"
              checked={unavailableOnly}
              onChange={(e) => {
                setUnavailableOnly(e.target.checked);
                writeLocal(UNAVAILABLE_KEY, e.target.checked ? "1" : "0");
              }}
            />
            Show unavailable only
          </label>
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
            <span className="text-muted-foreground">
              {unavailableOnly && allPlans.length
                ? `No plan in this range has an unavailable crew member (${allPlans.length} plans hidden).`
                : "No spray plans in this range."}
            </span>
            {data.latest_plan_date && (
              <Button size="sm" variant="secondary" onClick={jumpToLatest}>
                Jump to latest plans ({data.latest_plan_date})
              </Button>
            )}
          </div>
        )}

        {((data && plans.length > 0) || skeleton) &&
          (view === "calendar" ? (
            <ScheduleCalendar
              plans={plans}
              from={shownFrom}
              to={shownTo}
              loading={skeleton}
              onOpen={(p) => openPlan(p.name)}
            />
          ) : (
            <ScheduleGantt
              plans={plans}
              leaves={data?.leaves || []}
              loading={skeleton}
              from={shownFrom}
              to={shownTo}
              rowsBy={rowsBy}
              onOpen={(p) => openPlan(p.name)}
            />
          ))}
      </div>
      )}
    </div>
  );
}
