/**
 * Personnel ▸ Scouts — the crop's scouts, ranked, and each one's record
 * (personnel spec P4, P5). Read-only.
 *
 * The layout is the Livestock Animals page's, adapted to people: a searchable
 * list beside a record. The list carries the ranking (rank #, score); the
 * record is the portrait (Employee photo, initials only without one), the score
 * and its parts as figures and as a radar against the farm median, the houses
 * walked, the weeks, and the scout's open quality flags.
 *
 * Server: serverscripts/scouts/api.get_scouts — the quality aggregate's scout
 * rows (the Coverage report's), ranked by common/scout_ranking.py. Farm scope
 * and roles are enforced there.
 */
import { useEffect, useMemo, useState } from "react";
import { BarChart3, CalendarDays, ChevronLeft, MapPinned } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PlacePicker } from "@/components/PlacePicker";
import { DateRangePicker } from "@/components/DateRangePicker";
import { LoadProgress, TextSkeleton } from "@/components/Loading";
import { Figure, FigureRow } from "@/components/people/Figure";
import { PersonList, type PersonListGroup } from "@/components/people/PersonList";
import { PersonPortrait, PersonPortraitSkeleton } from "@/components/people/PersonPortrait";
import { KpiRadar, KpiRadarSkeleton, type RadarAxis } from "@/components/people/KpiRadar";
import { ActivityFeed, ActivityFeedSkeleton, type FeedItem } from "@/components/people/ActivityFeed";
import { CompareDialog } from "@/components/people/CompareDialog";
import { useDashboardAggregate } from "@/hooks/use-dashboard-aggregate";
import { DEFAULT_CROP } from "@/lib/scouting-api";
import { onLeaveText, weekLabel, type FarmMedians, type ScoutRecord, type ScoutsPayload } from "@/lib/scouts-api";
import { KIND } from "@/pages/dashboard/DataQualityTab";
import { cn, ymd } from "@/lib/utils";

const ALL = "__all__";

/** The last four complete ISO weeks — the server's default too. */
export function lastFourWeeks(today = new Date()) {
  const back = today.getDay() === 0 ? 7 : today.getDay();
  const sunday = new Date(today);
  sunday.setDate(today.getDate() - back);
  const monday = new Date(sunday);
  monday.setDate(sunday.getDate() - 27);
  return { from: ymd(monday), to: ymd(sunday) };
}

const fmt = (v: number | null | undefined, unit = "") =>
  v == null ? "—" : `${Number(v).toLocaleString("en-US", { maximumFractionDigits: 1 })}${unit}`;

function median(values: (number | null | undefined)[]): number | null {
  const xs = values.filter((v): v is number => v != null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

/** The radar is the score's parts — each 0–100, outward is better. */
function axesOf(s: ScoutRecord): RadarAxis[] {
  return [
    {
      key: "effort",
      label: "Effort",
      value: s.effort == null ? null : s.effort / 100,
      readout: s.effort == null ? "—" : `${s.effort} · ${fmt(s.stationsPerDay)} stations/day`,
    },
    {
      key: "integrity",
      label: "Integrity",
      value: s.integrity == null ? null : s.integrity / 100,
      readout:
        s.integrity == null
          ? "—"
          : `${s.integrity} · ${fmt(s.tooFastPct, "%")} too fast, ${fmt(s.duplicatePct, "%")} dup.`,
    },
    {
      key: "gps",
      label: "GPS",
      value: s.gps == null ? null : s.gps / 100,
      readout: s.gps == null ? "—" : `${s.gps}${s.gpsNote ? ` · ${s.gpsNote}` : ` · ${fmt(s.offZonePct, "%")} off zone`}`,
    },
  ];
}

const MEDIAN_ROWS: { key: keyof FarmMedians & keyof ScoutRecord; label: string; unit?: string; lowerIsBetter?: boolean }[] = [
  { key: "stationsPerDay", label: "Stations / active day" },
  { key: "entriesPerDay", label: "Entries / active day" },
  { key: "entriesPerHour", label: "Entries / hour" },
  { key: "tooFastPct", label: "Too-fast moves", unit: "%", lowerIsBetter: true },
  { key: "duplicatePct", label: "Duplicates", unit: "%", lowerIsBetter: true },
  { key: "offZonePct", label: "Off zone", unit: "%", lowerIsBetter: true },
  { key: "nothingFoundPct", label: "Nothing found", unit: "%" },
];

function Pending({ label }: { label: string }) {
  return (
    <Card className="hidden xl:block">
      <CardContent className="flex min-h-[420px] flex-col items-center justify-center gap-2 text-center">
        <p className="text-[15px] font-medium text-[var(--sd-ink)]">{label}</p>
        <p className="max-w-[36ch] text-[13px] text-[var(--sd-muted)]">
          Search by name, ID or farm. Their score, houses and weeks open here.
        </p>
      </CardContent>
    </Card>
  );
}

export function Scouts({ initialCrop }: { initialCrop?: string } = {}) {
  const crop = initialCrop ?? DEFAULT_CROP;
  const [farm, setFarm] = useState<string>(""); // "" → the server's choice
  const [{ from, to }, setRange] = useState(() => lastFourWeeks());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);

  const q = useDashboardAggregate<ScoutsPayload>(
    "scouts",
    { from_date: from, to_date: to, crop, farm: farm === ALL ? "" : farm },
    true,
  );
  const data = q.data;
  // First load (nothing to show yet): the frame is drawn, the figures pending.
  const pending = !data && !q.error;

  const everyone = useMemo(
    () => (data ? [...data.ranked, ...data.notEnoughDays] : []),
    [data],
  );
  const byId = useMemo(() => new Map(everyone.map((s) => [s.scout, s])), [everyone]);
  const selected = selectedId ? byId.get(selectedId) ?? null : null;

  // Open on the top of the ranking; keep the pick while it stays in the list.
  useEffect(() => {
    if (!data) return;
    setSelectedId((cur) => (cur && byId.has(cur) ? cur : data.ranked[0]?.scout ?? data.notEnoughDays[0]?.scout ?? null));
  }, [data, byId]);

  const groups: PersonListGroup[] = useMemo(() => {
    if (!data) return [];
    const sub = (s: ScoutRecord) =>
      [s.farm, `${s.activeDays} days`, s.leaveDays ? onLeaveText(s.leaveDays) : null].filter(Boolean).join(" · ");
    return [
      {
        title: "Ranking",
        items: data.ranked.map((s) => ({
          id: s.scout, name: s.scoutName, image: s.image, sub: sub(s), keywords: s.farms.join(" "),
          rank: s.rank, figure: fmt(s.score), figureHint: "score",
        })),
      },
      {
        title: "Not enough days",
        note: `Fewer than ${data.minActiveDays} active days in the range (fewer needed for days on approved leave) — not ranked.`,
        items: data.notEnoughDays.map((s) => ({
          id: s.scout, name: s.scoutName, image: s.image, sub: sub(s), keywords: s.farms.join(" "),
        })),
      },
    ];
  }, [data]);

  const medianOf = (s: ScoutRecord | null) =>
    (s && data?.medians.find((m) => m.farm === s.farm)) || null;
  const farmMates = (s: ScoutRecord) => (data?.ranked || []).filter((r) => r.farm === s.farm);
  const benchmark = (s: ScoutRecord) => {
    const mates = farmMates(s);
    return (["effort", "integrity", "gps"] as const).map((k) => {
      const m = median(mates.map((r) => r[k]));
      return m == null ? null : m / 100;
    });
  };

  const med = medianOf(selected);
  const maxWeek = Math.max(1, ...(selected?.weeks || []).map((w) => w.entries));
  const weekFeed: FeedItem[] = (selected?.weeks || [])
    .slice()
    .reverse()
    .map((w) => ({
      key: String(w.week),
      group: "Weeks in range",
      label: `${weekLabel(w.week)} · ${w.entries.toLocaleString("en-US")} entries`,
      detail: selected && w.entries ? `${Math.round((100 * w.entries) / selected.entries)}% of the range` : undefined,
      icon: CalendarDays,
      tone: "var(--sd-data-indigo)",
    }));

  return (
    <div className="flex min-h-svh w-full min-w-0 flex-col">
      <PageHeader eyebrow="Personnel · Scouting" title="Scouts">
          <PlacePicker
            level="farm"
            farms={data?.farms || []}
            crop={crop}
            label="Scouts farm"
            allLabel={(data?.allFarms ?? true) ? undefined : false}
            value={{ farm: farm === ALL ? "" : farm || data?.farm || "", greenhouse: "" }}
            onChange={(p) => setFarm(p.farm || ALL)}
            disabled={!data}
          />
          <DateRangePicker label="Scouts date range" value={{ from, to }} onChange={setRange} />
      </PageHeader>
      <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
        <LoadProgress
          active={q.loading && !!data}
          progress={q.progress?.percent ?? null}
          label={q.progress?.label}
          className="self-end"
        />
        {q.error && <div className="text-xs text-[var(--sd-data-red)]">Failed to load: {q.error}</div>}
        {data?.clamped && (
          <p className="text-xs text-[var(--sd-muted)]">
            Read from {data.range.from_date} — the longest window the figures cover.
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
                  selectedId={selected?.scout ?? null}
                  onSelect={setSelectedId}
                  label="Find a scout"
                  noun="scouts"
                  loading={pending}
                />
              </CardContent>
            </Card>
          </aside>

          {selected ? (
            <div className="flex min-w-0 flex-col gap-5" data-testid="scout-record">
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="flex items-center gap-1.5 self-start text-[12.5px] font-medium text-[var(--sd-muted)] hover:text-[var(--sd-ink)] xl:hidden"
              >
                <ChevronLeft className="h-4 w-4" />
                All scouts
              </button>
              <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,280px)]">
                <div className="flex min-w-0 flex-col gap-5">
                  <FigureRow>
                    <Figure
                      label="Score"
                      value={fmt(selected.score)}
                      hint={selected.rank ? `#${selected.rank} of ${data?.ranked.length}` : "not ranked"}
                    />
                    <Figure
                      label="Effort"
                      value={fmt(selected.effort)}
                      hint={`${fmt(selected.stationsPerDay)} stations/day`}
                    />
                    <Figure
                      label="Integrity"
                      value={fmt(selected.integrity)}
                      hint={`${fmt(selected.tooFastPct, "%")} too fast`}
                    />
                    <Figure
                      label="GPS"
                      value={fmt(selected.gps)}
                      hint={selected.gpsNote || `${fmt(selected.offZonePct, "%")} off zone`}
                    />
                  </FigureRow>
                  <div className="-mt-2 flex flex-wrap items-center gap-3">
                    <Button variant="outline" size="sm" disabled={!selected.eligible} onClick={() => setComparing(true)}>
                      <BarChart3 className="mr-1.5 h-3.5 w-3.5" />
                      Compare against the farm
                    </Button>
                    {!selected.eligible && (
                      <span className="text-[12.5px] text-[var(--sd-muted)]">
                        {selected.activeDays} active {selected.activeDays === 1 ? "day" : "days"} — ranked from{" "}
                        {selected.requiredDays ?? data?.minActiveDays}
                        {selected.leaveDays ? ` (${onLeaveText(selected.leaveDays)} excused)` : ""}.
                      </span>
                    )}
                    {data && (
                      <span className="text-[12px] text-[var(--sd-quiet)]">
                        Weights: effort {Math.round(data.weights.effort * 100)}, integrity{" "}
                        {Math.round(data.weights.integrity * 100)}, GPS {Math.round(data.weights.gps * 100)}
                      </span>
                    )}
                  </div>

                  <Card>
                    <CardHeader>
                      <CardTitle>Against the farm median</CardTitle>
                      <CardDescription>
                        {med ? `${selected.farm} — median of its ${med.scouts} ranked scouts.` : "No farm to compare with."}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <table className="w-full border-collapse text-[13px]" aria-label="Against the farm median">
                        <thead>
                          <tr className="border-b border-[var(--sd-line)] text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--sd-quiet)]">
                            <th className="py-2 pr-3">Measure</th>
                            <th className="py-2 pr-3 text-right">{selected.scoutName.split(" ")[0]}</th>
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
                                  {fmt(mine, r.unit)}
                                </td>
                                <td className="py-2 text-right tabular-nums text-[var(--sd-quiet)]">{fmt(theirs, r.unit)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>Open quality flags</CardTitle>
                      <CardDescription>From the Coverage report, for this range.</CardDescription>
                    </CardHeader>
                    <CardContent className="pt-0">
                      {selected.flags.length ? (
                        <ul className="flex flex-col gap-2" aria-label="Quality flags">
                          {selected.flags.map((f) => (
                            <li key={f.kind} className="flex flex-wrap items-baseline gap-2 text-[13px]">
                              <span
                                className="rounded-full px-2 py-px text-[11px] font-medium"
                                style={{ color: KIND[f.kind].color, boxShadow: `inset 0 0 0 1px ${KIND[f.kind].color}` }}
                              >
                                {KIND[f.kind].label}
                              </span>
                              <span className="text-[var(--sd-muted)]">{f.detail}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-[13px] text-[var(--sd-muted)]">No open flags.</p>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>Houses scouted</CardTitle>
                      <CardDescription>Share of their {selected.entries.toLocaleString("en-US")} entries.</CardDescription>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <ul className="flex flex-col gap-2" aria-label="Houses scouted">
                        {selected.houses.map((h) => {
                          const share = selected.entries ? (100 * h.entries) / selected.entries : 0;
                          return (
                            <li key={h.house} className="flex items-center gap-3 text-[12.5px]">
                              <MapPinned className="h-3.5 w-3.5 shrink-0 text-[var(--sd-quiet)]" />
                              <span className="w-40 shrink-0 truncate text-[var(--sd-ink)]" title={h.house}>{h.house}</span>
                              <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--sd-bg-soft)]">
                                <span className="block h-full rounded-full bg-[var(--sd-ink)]" style={{ width: `${share}%` }} />
                              </span>
                              <span className="w-12 shrink-0 text-right tabular-nums text-[var(--sd-muted)]">{Math.round(share)}%</span>
                            </li>
                          );
                        })}
                      </ul>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>Week by week</CardTitle>
                      <CardDescription>
                        Entries per ISO week; last active {selected.lastDate || "—"}.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-5 pt-0">
                      <div className="flex h-16 items-end gap-1.5" aria-label="Entries per week" role="img">
                        {selected.weeks.map((w) => (
                          <div key={w.week} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                            <span
                              className="w-full rounded-t-[3px] bg-[var(--sd-data-indigo)]"
                              style={{ height: `${Math.max(4, (48 * w.entries) / maxWeek)}px` }}
                              title={`${weekLabel(w.week)}: ${w.entries} entries`}
                            />
                            <span className="text-[10px] tabular-nums text-[var(--sd-quiet)]">{weekLabel(w.week)}</span>
                          </div>
                        ))}
                      </div>
                      <ActivityFeed items={weekFeed} empty="No entries in this range." />
                    </CardContent>
                  </Card>
                </div>

                <div className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-6 lg:self-start">
                  <PersonPortrait
                    id={selected.scout}
                    name={selected.scoutName}
                    image={selected.image}
                    pill={selected.rank ? `#${selected.rank}` : "Not ranked"}
                    facts={[
                      { label: selected.farms.length > 1 ? "Farms" : "Farm", value: selected.farms.join(", ") || "—" },
                      { label: "Active days", value: String(selected.activeDays) },
                      ...(selected.leaveDays
                        ? [{ label: "Approved leave", value: onLeaveText(selected.leaveDays) }]
                        : []),
                      { label: "Entries", value: selected.entries.toLocaleString("en-US") },
                      { label: "Last active", value: selected.lastDate || "—" },
                    ]}
                  />
                  <Card>
                    <CardHeader className="pb-0">
                      <CardTitle className="text-[14px]">Score parts</CardTitle>
                      <CardDescription>Outward is better on every axis.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <KpiRadar axes={axesOf(selected)} benchmark={benchmark(selected)} label="Score parts" />
                    </CardContent>
                  </Card>
                </div>
              </div>
            </div>
          ) : data ? (
            <Pending label={everyone.length ? "Pick a scout" : "No scouting in this range"} />
          ) : pending ? (
            <ScoutRecordSkeleton />
          ) : null}
        </div>
      </div>

      {selected && data && selected.eligible && (
        <CompareDialog
          open={comparing}
          onOpenChange={setComparing}
          subject={{ id: selected.scout, name: selected.scoutName, image: selected.image, sub: selected.farm || "" }}
          pool={data.ranked.map((s) => ({ id: s.scout, name: s.scoutName, image: s.image, sub: s.farm || "" }))}
          axesFor={(id) => axesOf(byId.get(id)!)}
          benchmark={benchmark(selected)}
          benchmarkReadouts={benchmark(selected).map((v) => (v == null ? "—" : fmt(v * 100)))}
          benchmarkLabel={selected.farm ? `${selected.farm} median` : "Farm median"}
        />
      )}
    </div>
  );
}

/** The record's own frame on the first load: the figure labels, card titles,
 *  the median table's measures and the portrait's fact labels are real; only
 *  the numbers, rows, photo and radar are pending. */
function ScoutRecordSkeleton() {
  return (
    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,280px)]">
      <div className="flex min-w-0 flex-col gap-5">
        <FigureRow>
          {["Score", "Effort", "Integrity", "GPS"].map((l) => (
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
              <thead>
                <tr className="border-b border-[var(--sd-line)] text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--sd-quiet)]">
                  <th className="py-2 pr-3">Measure</th>
                  <th className="py-2 pr-3 text-right"><TextSkeleton width="6ch" /></th>
                  <th className="py-2 text-right">Farm median</th>
                </tr>
              </thead>
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
        <Card>
          <CardHeader>
            <CardTitle>Open quality flags</CardTitle>
            <CardDescription>From the Coverage report, for this range.</CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <TextSkeleton width="16ch" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Houses scouted</CardTitle>
            <CardDescription><TextSkeleton width="18ch" /></CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <ActivityFeedSkeleton rows={3} />
          </CardContent>
        </Card>
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <PersonPortraitSkeleton facts={["Farm", "Active days", "Entries", "Last active"]} />
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
