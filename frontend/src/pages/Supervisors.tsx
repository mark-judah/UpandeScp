/**
 * Personnel ▸ Supervisors — each spray supervisor's record over a date range,
 * laid out like Personnel ▸ Scouts: a searchable list beside the selected
 * supervisor's portrait, figures set against the farm median, a six-axis radar,
 * the weeks, and their plan events. Read-only.
 *
 * Server: serverscripts/sprayers/supervisors.get_supervisors (+ supervisor_kpis.py
 * for the KPIs, medians, weekly trend and events). A plan counts for every
 * supervisor on its team; farm scope and roles are enforced there.
 */
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, BarChart3, CheckCircle2, ChevronLeft, Clock, Hourglass, XCircle,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PlaceMultiPicker } from "@/components/PlaceMultiPicker";
import { EMPTY_PLACE_SET, encodeNames, type PlaceSet } from "@/lib/places";
import { DateRangePicker } from "@/components/DateRangePicker";
import { LoadProgress, TextSkeleton } from "@/components/Loading";
import { Figure, FigureRow } from "@/components/people/Figure";
import { PersonList, type PersonListGroup } from "@/components/people/PersonList";
import { PersonPortrait, PersonPortraitSkeleton } from "@/components/people/PersonPortrait";
import { KpiRadar, KpiRadarSkeleton } from "@/components/people/KpiRadar";
import { ActivityFeed, ActivityFeedSkeleton, type FeedItem } from "@/components/people/ActivityFeed";
import { CompareDialog } from "@/components/people/CompareDialog";
import { useDashboardAggregate } from "@/hooks/use-dashboard-aggregate";
import { DEFAULT_CROP } from "@/lib/scouting-api";
import { onLeaveText, weekLabel } from "@/lib/scouts-api";
import {
  benchmarkOf, eventText, medianFor, minutesText, monthGroup, radarAxes, splitRanked, weekRate,
  type SupervisorEvent, type SupervisorRow, type SupervisorsPayload,
} from "@/lib/supervisors-api";
import { cn } from "@/lib/utils";
import { lastFourWeeks } from "@/pages/Scouts";

const ALL = "__all__";

const num = (v: number | null | undefined, unit = "") =>
  v == null ? "—" : `${Number(v).toLocaleString("en-US", { maximumFractionDigits: 1 })}${unit}`;
const count = (v: number) => v.toLocaleString("en-US");

type Fmt = "pct" | "min" | "num";
const show = (v: number | null | undefined, f: Fmt) =>
  f === "pct" ? num(v, "%") : f === "min" ? minutesText(v) : num(v);

/** Rows of the "against the farm median" table. `lowerIsBetter` colours the worse side. */
const MEDIAN_ROWS: {
  key: keyof SupervisorRow & keyof NonNullable<ReturnType<typeof medianFor>>;
  label: string;
  fmt: Fmt;
  lowerIsBetter?: boolean;
}[] = [
  { key: "completion_rate", label: "Completion rate", fmt: "pct", lowerIsBetter: false },
  { key: "on_time_pct", label: "Started on time", fmt: "pct", lowerIsBetter: false },
  { key: "median_start_delay_min", label: "Start vs planned time", fmt: "min", lowerIsBetter: true },
  { key: "accountability_pct", label: "Scanned by them", fmt: "pct", lowerIsBetter: false },
  { key: "median_spray_min", label: "Spray time per house", fmt: "min", lowerIsBetter: true },
  { key: "greenhouses_per_day", label: "Houses per spray day", fmt: "num", lowerIsBetter: false },
  { key: "offline_share", label: "Sprayed offline", fmt: "pct" },
  { key: "median_sync_min", label: "Spray end to sync", fmt: "min", lowerIsBetter: true },
  { key: "avg_team_size", label: "Team size", fmt: "num" },
  { key: "absence_rate", label: "Members not checked in", fmt: "pct", lowerIsBetter: true },
];

function Pending({ label }: { label: string }) {
  return (
    <Card className="hidden xl:block">
      <CardContent className="flex min-h-[420px] flex-col items-center justify-center gap-2 text-center">
        <p className="text-[15px] font-medium text-[var(--sd-ink)]">{label}</p>
        <p className="max-w-[36ch] text-[13px] text-[var(--sd-muted)]">
          Search by name, ID or farm. Their plans, punctuality and pace open here.
        </p>
      </CardContent>
    </Card>
  );
}

/** A labelled group of small measures inside one card. */
function Group({ title, note, items }: {
  title: string;
  note?: string;
  items: { label: string; value: string; hint?: string; bad?: boolean }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {note && <CardDescription>{note}</CardDescription>}
      </CardHeader>
      <CardContent className="pt-0">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3" aria-label={title}>
          {items.map((i) => (
            <div key={i.label} className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--sd-quiet)]">{i.label}</dt>
              <dd
                className={cn(
                  "text-[18px] font-semibold tabular-nums tracking-[-0.02em]",
                  i.bad ? "text-[var(--sd-sev-critical)]" : "text-[var(--sd-ink)]",
                )}
              >
                {i.value}
              </dd>
              {i.hint && <span className="text-[11px] text-[var(--sd-quiet)]">{i.hint}</span>}
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

const EVENT_ICON: Record<string, { icon: LucideIcon; tone: string }> = {
  on_time: { icon: CheckCircle2, tone: "var(--sd-data-green)" },
  late: { icon: Clock, tone: "var(--sd-data-amber)" },
  missed: { icon: AlertTriangle, tone: "var(--sd-sev-critical)" },
  never_started: { icon: XCircle, tone: "var(--sd-sev-critical)" },
  none: { icon: Hourglass, tone: "var(--sd-muted)" },
};

function feedOf(events: SupervisorEvent[]): FeedItem[] {
  return events.map((e) => {
    const { label, detail } = eventText(e);
    const { icon, tone } = EVENT_ICON[e.outcome ?? "none"];
    return {
      key: e.plan,
      group: monthGroup(e.scheduled),
      label,
      detail,
      aside: e.scheduled ? e.scheduled.slice(5, 16).replace("T", " ") : undefined,
      icon,
      tone,
    };
  });
}

export function Supervisors({ initialCrop }: { initialCrop?: string } = {}) {
  const crop = initialCrop ?? DEFAULT_CROP;
  // Empty and never picked → every farm the user may see; empty after a pick → the same.
  const [places, setPlaces] = useState<PlaceSet>(EMPTY_PLACE_SET);
  const [picked, setPicked] = useState(false);
  const farm = places.farms.length ? encodeNames(places.farms) : picked ? ALL : "";
  const [{ from, to }, setRange] = useState(() => lastFourWeeks());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);

  const q = useDashboardAggregate<SupervisorsPayload>(
    "supervisors",
    { from_date: from, to_date: to, crop, farm },
    true,
  );
  const data = q.data;
  const pending = !data && !q.error;

  const { ranked, unranked } = useMemo(() => splitRanked(data?.rows ?? []), [data]);
  const byId = useMemo(() => new Map((data?.rows ?? []).map((s) => [s.employee, s])), [data]);
  const selected = selectedId ? byId.get(selectedId) ?? null : null;

  // Open on the top of the ranking; keep the pick while it stays in the list.
  useEffect(() => {
    if (!data) return;
    setSelectedId((cur) => (cur && byId.has(cur) ? cur : ranked[0]?.employee ?? unranked[0]?.employee ?? null));
  }, [data, byId, ranked, unranked]);

  const groups: PersonListGroup[] = useMemo(() => {
    const sub = (s: SupervisorRow) =>
      [s.farm, `${s.assigned} plans`, s.leave_days ? onLeaveText(s.leave_days) : null].filter(Boolean).join(" · ");
    return [
      {
        title: "Ranking",
        note: "By share of due plans started on time.",
        items: ranked.map((s) => ({
          id: s.employee, name: s.name, image: s.image, sub: sub(s), keywords: s.farms.join(" "),
          rank: s.rank ?? undefined, figure: num(s.on_time_pct, "%"), figureHint: "on time",
        })),
      },
      {
        title: "Nothing due",
        note: "No plan of theirs has come due in the range, so they are not ranked.",
        items: unranked.map((s) => ({
          id: s.employee, name: s.name, image: s.image, sub: sub(s), keywords: s.farms.join(" "),
        })),
      },
    ];
  }, [ranked, unranked]);

  const med = medianFor(data, selected);
  const bench = benchmarkOf(med);
  const maxWeek = Math.max(1, ...(selected?.weeks || []).map((w) => w.plans));

  return (
    <div className="flex min-h-svh w-full min-w-0 flex-col">
      <PageHeader eyebrow="Personnel · Spraying" title="Supervisors">
        <PlaceMultiPicker
          farms={data?.farms || []}
          crop={crop}
          label="Supervisors farm"
          value={places}
          onChange={(p) => {
            setPicked(true);
            setPlaces(p);
          }}
          disabled={!data}
        />
        <DateRangePicker label="Supervisors date range" value={{ from, to }} onChange={setRange} />
      </PageHeader>
      <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
        <LoadProgress
          active={q.loading && !!data}
          progress={q.progress?.percent ?? null}
          label={q.progress?.label}
          className="self-end"
        />
        {q.error && <div className="text-xs text-[var(--sd-data-red)]">Failed to load: {q.error}</div>}
        {data && data.no_supervisor > 0 && (
          <p className="text-xs text-[var(--sd-muted)]">
            {data.no_supervisor} plan{data.no_supervisor === 1 ? " has" : "s have"} no supervisor on the team, so
            they count for nobody here.
          </p>
        )}

        <div
          className="relative grid min-w-0 gap-5 xl:grid-cols-[minmax(0,300px)_minmax(0,1fr)]"
          aria-busy={pending || undefined}
        >
          <aside className={cn("min-w-0 xl:sticky xl:top-6 xl:self-start", selected && "hidden xl:block")}>
            <Card className="flex min-h-0 flex-col overflow-hidden">
              <CardContent className="flex min-h-0 flex-col p-4">
                <PersonList
                  groups={groups}
                  selectedId={selected?.employee ?? null}
                  onSelect={setSelectedId}
                  label="Find a supervisor"
                  noun="supervisors"
                  loading={pending}
                />
              </CardContent>
            </Card>
          </aside>

          {selected ? (
            <div className="flex min-w-0 flex-col gap-5" data-testid="supervisor-record">
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="flex items-center gap-1.5 self-start text-[12.5px] font-medium text-[var(--sd-muted)] hover:text-[var(--sd-ink)] xl:hidden"
              >
                <ChevronLeft className="h-4 w-4" />
                All supervisors
              </button>
              <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,280px)]">
                <div className="flex min-w-0 flex-col gap-5">
                  <FigureRow>
                    <Figure
                      label="Plans"
                      value={count(selected.assigned)}
                      hint={`${count(selected.completed)} completed · ${num(selected.completion_rate, "%")}`}
                    />
                    <Figure
                      label="On time"
                      value={num(selected.on_time_pct, "%")}
                      hint={`${selected.late} late · ${selected.missed} missed`}
                    />
                    <Figure
                      label="Scanned by them"
                      value={num(selected.accountability_pct, "%")}
                      hint={`${selected.by_other} by others · ${selected.nobody} by nobody`}
                    />
                    <Figure
                      label="Score"
                      value={num(selected.score)}
                      hint={selected.rank ? `#${selected.rank} of ${ranked.length}` : "not ranked"}
                    />
                  </FigureRow>
                  <div className="-mt-2 flex flex-wrap items-center gap-3">
                    <Button variant="outline" size="sm" onClick={() => setComparing(true)}>
                      <BarChart3 className="mr-1.5 h-3.5 w-3.5" />
                      Compare against the farm
                    </Button>
                    <span className="text-[12px] text-[var(--sd-quiet)]">
                      Score is the mean of the radar axes; the rank is by on-time share.
                    </span>
                  </div>

                  <Card>
                    <CardHeader>
                      <CardTitle>Against the farm median</CardTitle>
                      <CardDescription>
                        {med
                          ? `${selected.farm} — median of its ${med.supervisors} supervisors.`
                          : "No farm to compare with."}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <table className="w-full border-collapse text-[13px]" aria-label="Against the farm median">
                        <thead>
                          <tr className="border-b border-[var(--sd-line)] text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--sd-quiet)]">
                            <th className="py-2 pr-3">Measure</th>
                            <th className="py-2 pr-3 text-right">{selected.name.split(" ")[0]}</th>
                            <th className="py-2 text-right">Farm median</th>
                          </tr>
                        </thead>
                        <tbody>
                          {MEDIAN_ROWS.map((r) => {
                            const mine = selected[r.key] as number | null;
                            const theirs = med ? (med[r.key] as number | null) : null;
                            const worse =
                              mine != null && theirs != null && r.lowerIsBetter !== undefined
                                ? r.lowerIsBetter ? mine > theirs : mine < theirs
                                : false;
                            return (
                              <tr key={r.key} className="border-b border-[var(--sd-line-soft)] last:border-0">
                                <td className="py-2 pr-3 text-[var(--sd-muted)]">{r.label}</td>
                                <td className={cn("py-2 pr-3 text-right tabular-nums", worse ? "text-[var(--sd-sev-critical)]" : "text-[var(--sd-ink)]")}>
                                  {show(mine, r.fmt)}
                                </td>
                                <td className="py-2 text-right tabular-nums text-[var(--sd-quiet)]">{show(theirs, r.fmt)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </CardContent>
                  </Card>

                  <Group
                    title="Punctuality"
                    note={`On time is started within ${data?.grace_hours ?? 2} h of the planned time; late is the same day; missed is a later day.`}
                    items={[
                      { label: "On time", value: count(selected.on_time), hint: `of ${count(selected.due)} due` },
                      { label: "Late", value: count(selected.late), hint: `${selected.late_amber} amber · ${selected.late_orange} orange · ${selected.late_red} red` },
                      { label: "Past the cutoff", value: count(selected.late_past_cutoff), hint: "late starts after the day's cutoff", bad: selected.late_past_cutoff > 0 },
                      { label: "Missed", value: count(selected.missed), hint: "started a later day", bad: selected.missed > 0 },
                      { label: "Never started", value: count(selected.never_started), bad: selected.never_started > 0 },
                      { label: "Start vs plan", value: minutesText(selected.median_start_delay_min), hint: "median; minus is early" },
                    ]}
                  />
                  <Group
                    title="Accountability"
                    note="Who scanned a chemical at the store or started the spray."
                    items={[
                      { label: "By them", value: count(selected.acted), hint: `of ${count(selected.assigned)} plans` },
                      { label: "By someone else", value: count(selected.by_other) },
                      { label: "By nobody", value: count(selected.nobody), bad: selected.nobody > 0 },
                      { label: "Ran for others", value: count(selected.covered_for_others), hint: "plans of other supervisors" },
                    ]}
                  />
                  <Group
                    title="Pace"
                    items={[
                      { label: "Tank mix to start", value: minutesText(selected.median_mix_to_start_min), hint: "median" },
                      { label: "Spray time per house", value: minutesText(selected.median_spray_min), hint: "median, start to end" },
                      { label: "Houses per spray day", value: num(selected.greenhouses_per_day) },
                    ]}
                  />
                  <Group
                    title="Offline"
                    note="A spray counts as offline when it reached the server 10 minutes or more after it ended."
                    items={[
                      { label: "Offline", value: count(selected.offline_plans), hint: `${count(selected.online_plans)} online · ${num(selected.offline_share, "%")}` },
                      { label: "Spray end to sync", value: minutesText(selected.median_sync_min), hint: "median, offline sprays" },
                      { label: "Held / partial / refused", value: `${selected.tokens_held} / ${selected.tokens_partial} / ${selected.tokens_refused}`, hint: "sync tokens", bad: selected.tokens_refused + selected.tokens_held > 0 },
                    ]}
                  />
                  <Group
                    title="Team"
                    note="Check-ins come from Time & Attendance, on the day the plan sprayed."
                    items={[
                      { label: "Average team", value: num(selected.avg_team_size), hint: "members per plan" },
                      { label: "Not checked in", value: num(selected.absence_rate, "%"), hint: `${count(selected.absent_member_days)} of ${count(selected.member_days)} member-days` },
                      { label: "Crew warnings", value: count(selected.crew_warnings), hint: "raised when the spray synced" },
                    ]}
                  />
                  <Group
                    title="Discipline"
                    items={[
                      { label: "Postponements", value: count(selected.postponements) },
                      { label: "Compliance", value: `${selected.compliance_warnings} / ${selected.compliance_overridden} / ${selected.compliance_awaiting}`, hint: "warnings / overridden / awaiting override" },
                      { label: "Refused by the server", value: count(selected.refusals), hint: "stock and tank-mix refusals", bad: selected.refusals > 0 },
                    ]}
                  />
                  <Group
                    title="Coverage"
                    items={[
                      { label: "Hectares sprayed", value: num(selected.hectares) },
                      { label: "Houses sprayed", value: count(selected.greenhouses_sprayed) },
                      { label: "Chemical scans complete", value: `${selected.scan_plans_complete} of ${selected.scan_plans}`, hint: "plans with every chemical scanned" },
                    ]}
                  />

                  <Card>
                    <CardHeader>
                      <CardTitle>Week by week</CardTitle>
                      <CardDescription>Plans per ISO week, with the share started on time.</CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-5 pt-0">
                      <div className="flex h-20 items-end gap-1.5" aria-label="Plans per week" role="img">
                        {selected.weeks.map((w) => {
                          const rate = weekRate(w);
                          return (
                            <div key={w.week} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                              <span className="text-[10px] tabular-nums text-[var(--sd-quiet)]">{rate == null ? "—" : `${Math.round(rate)}%`}</span>
                              <span
                                className="w-full rounded-t-[3px] bg-[var(--sd-data-indigo)]"
                                style={{ height: `${Math.max(4, (44 * w.plans) / maxWeek)}px` }}
                                title={`${weekLabel(w.week)}: ${w.plans} plans, ${w.on_time} on time of ${w.due} due`}
                              />
                              <span className="text-[10px] tabular-nums text-[var(--sd-quiet)]">{weekLabel(w.week)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>Plan events</CardTitle>
                      <CardDescription>
                        Their latest {selected.events.length} plans in the range, newest first.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <ActivityFeed items={feedOf(selected.events)} empty="No plans in this range." />
                    </CardContent>
                  </Card>
                </div>

                <div className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-6 lg:self-start">
                  <PersonPortrait
                    id={selected.employee}
                    name={selected.name}
                    image={selected.image}
                    pill={selected.rank ? `#${selected.rank}` : "Not ranked"}
                    facts={[
                      { label: selected.farms.length > 1 ? "Farms" : "Farm", value: selected.farms.join(", ") || "—" },
                      { label: "Plans", value: count(selected.assigned) },
                      ...(selected.leave_days
                        ? [{ label: "Approved leave", value: onLeaveText(selected.leave_days) }]
                        : []),
                      { label: "Hectares", value: num(selected.hectares) },
                      { label: "Team", value: selected.avg_team_size == null ? "—" : `${num(selected.avg_team_size)} on average` },
                    ]}
                  />
                  <Card>
                    <CardHeader className="pb-0">
                      <CardTitle className="text-[14px]">Score parts</CardTitle>
                      <CardDescription>Outward is better on every axis.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <KpiRadar axes={radarAxes(selected)} benchmark={bench} label="Score parts" />
                    </CardContent>
                  </Card>
                </div>
              </div>
            </div>
          ) : data ? (
            <Pending label={data.rows.length ? "Pick a supervisor" : "No spray plans with a supervisor in this range"} />
          ) : pending ? (
            <SupervisorRecordSkeleton />
          ) : null}
        </div>
      </div>

      {selected && data && (
        <CompareDialog
          open={comparing}
          onOpenChange={setComparing}
          subject={{ id: selected.employee, name: selected.name, image: selected.image, sub: selected.farm || "" }}
          pool={ranked.map((s) => ({ id: s.employee, name: s.name, image: s.image, sub: s.farm || "" }))}
          axesFor={(id) => radarAxes(byId.get(id)!)}
          benchmark={bench}
          benchmarkReadouts={bench.map((v) => (v == null ? "—" : num(v * 100)))}
          benchmarkLabel={selected.farm ? `${selected.farm} median` : "Farm median"}
        />
      )}
    </div>
  );
}

/** The record's own frame on the first load: figure labels, card titles and the
 *  median table's measures are real; only the numbers, rows, photo and radar pend. */
function SupervisorRecordSkeleton() {
  return (
    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,280px)]">
      <div className="flex min-w-0 flex-col gap-5">
        <FigureRow>
          {["Plans", "On time", "Scanned by them", "Score"].map((l) => (
            <Figure key={l} label={l} value="" loading />
          ))}
        </FigureRow>
        <div className="-mt-2">
          <Button variant="outline" size="sm" disabled>
            <BarChart3 className="mr-1.5 h-3.5 w-3.5" />
            Compare against the farm
          </Button>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Against the farm median</CardTitle>
            <CardDescription><TextSkeleton width="22ch" /></CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <table className="w-full border-collapse text-[13px]" aria-label="Against the farm median">
              <tbody>
                {MEDIAN_ROWS.map((r) => (
                  <tr key={r.key} className="border-b border-[var(--sd-line-soft)] last:border-0">
                    <td className="py-2 pr-3 text-[var(--sd-muted)]">{r.label}</td>
                    <td className="py-2 pr-3 text-right"><TextSkeleton width="4ch" /></td>
                    <td className="py-2 text-right"><TextSkeleton width="4ch" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
        {["Punctuality", "Accountability", "Pace"].map((t) => (
          <Card key={t}>
            <CardHeader>
              <CardTitle>{t}</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <TextSkeleton width="24ch" />
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardHeader>
            <CardTitle>Plan events</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ActivityFeedSkeleton rows={3} />
          </CardContent>
        </Card>
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <PersonPortraitSkeleton facts={["Farm", "Plans", "Hectares", "Team"]} />
        <Card>
          <CardHeader className="pb-0">
            <CardTitle className="text-[14px]">Score parts</CardTitle>
            <CardDescription>Outward is better on every axis.</CardDescription>
          </CardHeader>
          <CardContent>
            <KpiRadarSkeleton />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
