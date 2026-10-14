/**
 * Personnel ▸ Sprayers — the sprayer register, one person at a time (personnel
 * spec P6, laid out like the Livestock Animals page). Read-only.
 *
 * Left: everyone on the register, highest hazard-weighted exposure over 30
 * days first. Right: the portrait (Employee photo, initials only without one),
 * the four exposure figures, the shape of their exposure against the farm
 * median, exposure per product and their recent sprays. "All sprayers" keeps
 * the sortable register table.
 *
 * Server: serverscripts/sprayers/api.py (get_sprayers, get_sprayer_detail); a
 * creator or supervisor sees only their rostered farms.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BarChart3, ChevronLeft, Droplets, Info, TriangleAlert } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Figure, FigureRow } from "@/components/people/Figure";
import { PersonList } from "@/components/people/PersonList";
import { PersonPortrait, PersonPortraitSkeleton } from "@/components/people/PersonPortrait";
import { KpiRadar, KpiRadarSkeleton, type RadarAxis } from "@/components/people/KpiRadar";
import { ActivityFeed, ActivityFeedSkeleton, type FeedItem } from "@/components/people/ActivityFeed";
import { CompareDialog } from "@/components/people/CompareDialog";
import { SprayersTab } from "@/components/teams/SprayersTab";
import { DEFAULT_CROP } from "@/lib/scouting-api";
import {
  fetchSprayerDetail,
  fetchSprayers,
  type SprayerDetail,
  type SprayerRow,
  type SprayersPayload,
} from "@/lib/teams-api";
import { TableRowsSkeleton } from "@/components/Loading";
import { cn } from "@/lib/utils";

const hrs = (n: number | null | undefined) =>
  n ? n.toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) : "—";

const MEASURES: { key: "hours_30d" | "weighted_30d" | "hours_total" | "weighted_total"; label: string }[] = [
  { key: "hours_30d", label: "Hours 30d" },
  { key: "weighted_30d", label: "Weighted 30d" },
  { key: "hours_total", label: "Hours total" },
  { key: "weighted_total", label: "Weighted total" },
];

function median(xs: number[]): number | null {
  const v = xs.slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Per farm: the max of each measure (the radar's outer ring) and its median. */
function farmStats(rows: SprayerRow[]) {
  const out = new Map<string, { max: number[]; median: (number | null)[] }>();
  const byFarm = new Map<string, SprayerRow[]>();
  for (const r of rows) {
    const k = r.farm || "";
    if (!byFarm.has(k)) byFarm.set(k, []);
    byFarm.get(k)!.push(r);
  }
  for (const [farm, rs] of byFarm) {
    out.set(farm, {
      max: MEASURES.map((m) => Math.max(0, ...rs.map((r) => r[m.key] || 0))),
      median: MEASURES.map((m) => median(rs.map((r) => r[m.key] || 0))),
    });
  }
  return out;
}

/** The record's frame on the first load: figure labels, card titles, the
 *  product table's columns and the portrait's fact labels are real. */
function SprayerRecordSkeleton() {
  return (
    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,280px)]">
      <div className="flex min-w-0 flex-col gap-5">
        <FigureRow>
          {MEASURES.map((m) => (
            <Figure key={m.key} label={m.label} value="" loading />
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
            <CardTitle>Exposure per product</CardTitle>
            <CardDescription>WHO class I weighs 4 … IV 1; an unclassified product counts 2.</CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <ProductTableFrame>
              <TableRowsSkeleton cols={5} rows={3} />
            </ProductTableFrame>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recent sprays</CardTitle>
            <CardDescription>The latest 20 sessions, newest first.</CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <ActivityFeedSkeleton />
          </CardContent>
        </Card>
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <PersonPortraitSkeleton facts={["Employee", "Farm", "Team", "Designation", "Status", "Last exposure"]} />
        <Card>
          <CardHeader className="pb-0">
            <CardTitle className="text-[14px]">Exposure shape</CardTitle>
            <CardDescription>Outward is more exposure; the ring is the farm's highest.</CardDescription>
          </CardHeader>
          <CardContent>
            <KpiRadarSkeleton />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** The exposure-per-product table's heading row, around its body rows. */
function ProductTableFrame({ children }: { children: ReactNode }) {
  return (
    <Table aria-label="Exposure per product">
      <TableHeader>
        <TableRow>
          <TableHead>Product</TableHead>
          <TableHead>Toxicity</TableHead>
          <TableHead className="text-right">Sessions</TableHead>
          <TableHead className="text-right">Hours</TableHead>
          <TableHead className="text-right">Weighted</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

export function Sprayers({ initialCrop }: { initialCrop?: string } = {}) {
  const crop = initialCrop ?? DEFAULT_CROP;
  const [data, setData] = useState<SprayersPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"records" | "table">("records");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, SprayerDetail>>({});
  const [comparing, setComparing] = useState(false);

  useEffect(() => {
    let alive = true;
    setError(null);
    fetchSprayers(crop)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setSelectedId((cur) => cur ?? d.sprayers[0]?.name ?? null);
      })
      .catch((e) => alive && setError(e?.message || "Failed to load sprayers"));
    return () => {
      alive = false;
    };
  }, [crop]);

  // First load: the tabs, list and record frame are drawn; the data pending.
  const pending = !data && !error;

  const byId = useMemo(() => new Map((data?.sprayers || []).map((r) => [r.name, r])), [data]);
  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const detail = selected ? details[selected.name] ?? null : null;
  const stats = useMemo(() => farmStats(data?.sprayers || []), [data]);

  useEffect(() => {
    if (!selected || details[selected.name]) return;
    let alive = true;
    fetchSprayerDetail(selected.name, crop)
      .then((d) => alive && setDetails((s) => ({ ...s, [selected.name]: d })))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [selected, details, crop]);

  const axesFor = (id: string): RadarAxis[] => {
    const r = byId.get(id)!;
    const st = stats.get(r.farm || "");
    return MEASURES.map((m, i) => ({
      key: m.key,
      label: m.label,
      value: st && st.max[i] ? (r[m.key] || 0) / st.max[i] : 0,
      readout: `${hrs(r[m.key])} h`,
    }));
  };
  const benchmarkFor = (r: SprayerRow) => {
    const st = stats.get(r.farm || "");
    return MEASURES.map((_, i) => (st && st.max[i] && st.median[i] != null ? (st.median[i] as number) / st.max[i] : null));
  };
  const benchmarkReadouts = (r: SprayerRow) => {
    const st = stats.get(r.farm || "");
    return MEASURES.map((_, i) => (st?.median[i] != null ? `${hrs(st.median[i])} h` : "—"));
  };

  const sprays: FeedItem[] = (detail?.sessions || []).map((s) => ({
    key: s.logsheet,
    group: s.date ? new Date(s.date + "T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" }) : "Undated",
    label: s.products || "—",
    detail: [
      s.greenhouse,
      s.role,
      s.ppe_condition ? `PPE ${s.ppe_condition}` : null,
      s.toxicity ? `Class ${s.toxicity}` : "hazard class unknown",
      s.flags?.includes("no duration") ? "no time recorded" : `${hrs(s.hours)} h`,
    ]
      .filter(Boolean)
      .join(" · "),
    aside: s.date?.slice(5),
    icon: Droplets,
    tone: (s.hazard_weight || 0) >= 3 ? "var(--sd-data-red)" : "var(--sd-data-cyan)",
  }));

  const list = (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <CardContent className="flex min-h-0 flex-col p-4">
        <PersonList
          groups={[
            {
              items: (data?.sprayers || []).map((r) => ({
                id: r.name,
                name: r.employee_name,
                image: r.image,
                sub: [r.farm, r.spray_team, r.role].filter(Boolean).join(" · "),
                keywords: `${r.employee} ${r.status}`,
                figure: hrs(r.weighted_30d),
                figureHint: "wt 30d",
              })),
            },
          ]}
          selectedId={selected?.name ?? null}
          onSelect={setSelectedId}
          placeholder="ID, name, farm or team…"
          label="Find a sprayer"
          noun="sprayers"
          loading={pending}
        />
      </CardContent>
    </Card>
  );

  return (
    <div className="flex min-h-svh w-full min-w-0 flex-col">
      <PageHeader eyebrow="Personnel · Exposure" title="Sprayers" />
      <div className="flex min-w-0 flex-1 flex-col px-4 py-4 md:px-6 md:py-6">
        {error && !data ? (
          <Card>
            <CardContent className="flex items-center justify-center py-12 text-sm text-destructive">{error}</CardContent>
          </Card>
        ) : (
          <Tabs value={view} onValueChange={(v) => setView(v as "records" | "table")} className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <TabsList className="self-start">
                <TabsTrigger value="records">Records</TabsTrigger>
                <TabsTrigger value="table">All sprayers</TabsTrigger>
              </TabsList>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {data && data.flags.no_duration > 0 && (
                  <span className="flex items-center gap-1" title="Logsheets with no start/stop time: counted as 0 h">
                    <TriangleAlert className="h-3.5 w-3.5 text-amber-600" />
                    <span className="tabular-nums">{data.flags.no_duration}</span> rows with no duration
                  </span>
                )}
                {data && data.flags.hazard_unknown > 0 && (
                  <span className="flex items-center gap-1" title="Products with no toxicity class: weighted 2 until classified">
                    <Info className="h-3.5 w-3.5" />
                    <span className="tabular-nums">{data.flags.products_unclassified}</span> products lack a hazard class
                  </span>
                )}
              </div>
            </div>
            <TabsContent value="records" className="mt-0">
              <div aria-busy={pending || undefined} className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
                <aside className={cn("min-w-0 xl:sticky xl:top-6 xl:self-start", selected && "hidden xl:block")}>{list}</aside>
                {selected ? (
                  <div className="flex min-w-0 flex-col gap-5" data-testid="sprayer-record">
                    <button
                      type="button"
                      onClick={() => setSelectedId(null)}
                      className="flex items-center gap-1.5 self-start text-[12.5px] font-medium text-[var(--sd-muted)] hover:text-[var(--sd-ink)] xl:hidden"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      All sprayers
                    </button>
                    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,280px)]">
                      <div className="flex min-w-0 flex-col gap-5">
                        <FigureRow>
                          <Figure label="Hours 30d" value={hrs(selected.hours_30d)} unit="h" />
                          <Figure label="Weighted 30d" value={hrs(selected.weighted_30d)} unit="h" hint="hours × hazard weight" />
                          <Figure label="Hours total" value={hrs(selected.hours_total)} unit="h" />
                          <Figure label="Weighted total" value={hrs(selected.weighted_total)} unit="h" />
                        </FigureRow>
                        <div className="-mt-2">
                          <Button variant="outline" size="sm" onClick={() => setComparing(true)}>
                            <BarChart3 className="mr-1.5 h-3.5 w-3.5" />
                            Compare against the farm
                          </Button>
                        </div>
                        <Card>
                          <CardHeader>
                            <CardTitle>Exposure per product</CardTitle>
                            <CardDescription>WHO class I weighs 4 … IV 1; an unclassified product counts 2.</CardDescription>
                          </CardHeader>
                          <CardContent className="pt-0">
                            {!detail ? (
                              <ProductTableFrame>
                                <TableRowsSkeleton cols={5} rows={3} />
                              </ProductTableFrame>
                            ) : (
                              <ProductTableFrame>
                                {detail.products.map((p) => (
                                  <TableRow key={p.spray_product || p.product_name}>
                                    <TableCell>{p.product_name}</TableCell>
                                    <TableCell>
                                      {p.toxicity ? (
                                        <Badge variant="secondary">Class {p.toxicity}</Badge>
                                      ) : (
                                        <Badge variant="outline" className="text-amber-700 dark:text-amber-500">Unknown</Badge>
                                      )}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">{p.sessions}</TableCell>
                                    <TableCell className="text-right tabular-nums">{hrs(p.hours)}</TableCell>
                                    <TableCell className="text-right tabular-nums">{hrs(p.weighted_hours)}</TableCell>
                                  </TableRow>
                                ))}
                                {!detail.products.length && (
                                  <TableRow>
                                    <TableCell colSpan={5} className="py-4 text-center text-sm text-muted-foreground">
                                      No recorded exposure.
                                    </TableCell>
                                  </TableRow>
                                )}
                              </ProductTableFrame>
                            )}
                          </CardContent>
                        </Card>
                        <Card>
                          <CardHeader>
                            <CardTitle>Recent sprays</CardTitle>
                            <CardDescription>The latest 20 sessions, newest first.</CardDescription>
                          </CardHeader>
                          <CardContent className="pt-0">
                            {detail ? (
                              <ActivityFeed items={sprays} empty="No sprays recorded against them yet." />
                            ) : (
                              <ActivityFeedSkeleton />
                            )}
                          </CardContent>
                        </Card>
                      </div>
                      <div className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-6 lg:self-start">
                        <PersonPortrait
                          id={selected.name}
                          name={selected.employee_name}
                          image={selected.image}
                          pill={selected.status === "Inactive" ? "Inactive" : selected.role}
                          facts={[
                            { label: "Employee", value: selected.employee },
                            { label: "Farm", value: selected.farm || "—" },
                            { label: "Team", value: selected.spray_team || "—" },
                            { label: "Designation", value: selected.designation || "—" },
                            { label: "Status", value: selected.status },
                            { label: "Last exposure", value: selected.last_exposure || "—" },
                          ]}
                        />
                        <Card>
                          <CardHeader className="pb-0">
                            <CardTitle className="text-[14px]">Exposure shape</CardTitle>
                            <CardDescription>Outward is more exposure; the ring is the farm's highest.</CardDescription>
                          </CardHeader>
                          <CardContent>
                            <KpiRadar axes={axesFor(selected.name)} benchmark={benchmarkFor(selected)} label="Exposure" />
                          </CardContent>
                        </Card>
                      </div>
                    </div>
                  </div>
                ) : pending ? (
                  <SprayerRecordSkeleton />
                ) : (
                  <Card className="hidden xl:block">
                    <CardContent className="flex min-h-[420px] items-center justify-center text-[13px] text-[var(--sd-muted)]">
                      {data?.sprayers.length ? "Pick a sprayer." : "Nobody on the register for your farms yet."}
                    </CardContent>
                  </Card>
                )}
              </div>
            </TabsContent>
            <TabsContent value="table" className="mt-0">
              <SprayersTab
                data={data}
                crop={crop}
                showFlags={false}
                onSelect={(r) => {
                  setSelectedId(r.name);
                  setView("records");
                }}
              />
            </TabsContent>
          </Tabs>
        )}
      </div>
      {selected && (
        <CompareDialog
          open={comparing}
          onOpenChange={setComparing}
          subject={{ id: selected.name, name: selected.employee_name, image: selected.image, sub: selected.farm || "" }}
          pool={(data?.sprayers || []).map((r) => ({ id: r.name, name: r.employee_name, image: r.image, sub: r.farm || "" }))}
          axesFor={axesFor}
          benchmark={benchmarkFor(selected)}
          benchmarkReadouts={benchmarkReadouts(selected)}
          benchmarkLabel={selected.farm ? `${selected.farm} median` : "Farm median"}
          direction="Outward is more exposure; the outer ring is the farm's highest."
        />
      )}
    </div>
  );
}
