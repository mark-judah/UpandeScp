/**
 * Per-hectare cards for the Pests / Diseases tabs of a block-grown crop
 * (avocado). The figure is the cumulative count over the ISO week divided by the
 * block's area, from the server (cumulative_per_ha); these cards only draw it.
 * A greenhouse crop (roses) never renders them: its tabs keep the station
 * prevalence figures.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RevealLTR } from "@/components/RevealLTR";
import { ChartSkeleton } from "@/components/Loading";
import { ObservationName } from "@/components/gallery/ObservationGallery";
import { formatPerHa, perHaLabel } from "@/lib/cumulative-api";
import { CardRowsSkeleton } from "./slot-skeletons";
import { EmptyHint } from "./EmptyHint";
import type { PerHaBlockRow, PerHaPayload, PerHaRankingRow } from "./pests-diseases-types";

const CONFIG: ChartConfig = { perHa: { label: "/ ha this week", color: "var(--sd-data-cyan)" } };

/** "12.4 / ha (line 8)" — the figure and, when one is set, the line it is judged on. */
function judged(v: number | null | undefined, threshold: number | null | undefined): string {
  const base = perHaLabel(v);
  return threshold ? `${base} · line ${formatPerHa(threshold)}` : base;
}

function OverPill({ over, hasLine }: { over: boolean; hasLine: boolean }) {
  const tone = over ? "var(--sd-data-red)" : hasLine ? "var(--sd-data-green)" : "var(--sd-muted)";
  const text = over ? "Over line" : hasLine ? "Under line" : "No line set";
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-px text-[0.6rem] font-medium leading-none whitespace-nowrap"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
    >
      {text}
    </span>
  );
}

const axisPerHa = (v: number) => formatPerHa(v);

export function PerHaDistributionCard({
  title, perHa, colorFor, loading,
}: { title: string; perHa?: PerHaPayload; colorFor: (name: string) => string; loading: boolean }) {
  const rows = (perHa?.ranking ?? []).filter((r) => r.perHa !== null).slice(0, 12);
  return (
    <Card className="p-4">
      <CardHeader className="p-0 pb-2">
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          Cumulative / ha · {perHa?.round.label ?? "this ISO week"} · scouted blocks with an area
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <ChartSkeleton height={288} />
        ) : rows.length ? (
          <RevealLTR>
            <ChartContainer config={CONFIG} className="h-72">
              <BarChart data={rows} layout="vertical" margin={{ left: 12, right: 12 }}>
                <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={axisPerHa} />
                <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={120} />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      indicator="line"
                      formatter={(v, _n, item) => judged(Number(v), (item as { payload?: PerHaRankingRow } | undefined)?.payload?.threshold)}
                    />
                  }
                />
                <Bar isAnimationActive={false} dataKey="perHa" radius={[3, 3, 3, 3]}>
                  {rows.map((r) => (
                    <Cell key={r.name} fill={colorFor(r.name)} />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>
          </RevealLTR>
        ) : (
          <EmptyHint title="Nothing recorded this week" hint="No block with an area was scouted in the current ISO week." />
        )}
      </CardContent>
    </Card>
  );
}

export function PerHaSeverityCard({
  title, kind, perHa, colorFor, loading,
}: { title: string; kind: "pest" | "disease"; perHa?: PerHaPayload; colorFor: (name: string) => string; loading: boolean }) {
  const rows = (perHa?.ranking ?? []).slice(0, 8);
  return (
    <Card className="p-4">
      <CardHeader className="p-0 pb-2">
        <CardTitle>{title}</CardTitle>
        <CardDescription>Per {kind} · / ha this week against its threshold line</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <CardRowsSkeleton rows={6} twoLine />
        ) : rows.length ? (
          <div className="flex flex-col gap-1.5">
            {rows.map((r) => (
              <div
                key={r.name}
                data-testid="per-ha-row"
                className="grid grid-cols-[1fr_auto] gap-3 items-center px-3 py-2 rounded-md border bg-[var(--sd-bg-soft)]"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full shrink-0 border" style={{ background: colorFor(r.name) }} aria-hidden />
                    <ObservationName kind={kind} name={r.name} className="truncate" />
                  </div>
                  <div className="mt-1 text-[0.7rem] text-muted-foreground tabular-nums">
                    {judged(r.perHa, r.threshold)}
                    {r.threshold ? ` · ${r.blocksOver} of ${r.blocks} block${r.blocks === 1 ? "" : "s"} over` : ""}
                  </div>
                </div>
                <OverPill over={r.over || r.blocksOver > 0} hasLine={!!r.threshold} />
              </div>
            ))}
          </div>
        ) : (
          <EmptyHint />
        )}
      </CardContent>
    </Card>
  );
}

export function PerHaBlocksCard({
  title, perHa, observation, loading,
}: { title: string; perHa?: PerHaPayload; observation: string; loading: boolean }) {
  const rows: PerHaBlockRow[] = (perHa?.byBlock ?? []).filter((r) => r.perHa !== null).slice(0, 12);
  const noArea = perHa?.noArea ?? [];
  return (
    <Card className="p-4">
      <CardHeader className="p-0 pb-2">
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          {observation || "All"} · cumulative / ha · {perHa?.round.label ?? "this ISO week"}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <ChartSkeleton height={288} />
        ) : rows.length ? (
          <RevealLTR>
            <ChartContainer config={CONFIG} className="h-72">
              <BarChart data={rows} layout="vertical" margin={{ left: 12, right: 12 }}>
                <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={axisPerHa} />
                <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={140} tick={{ fontSize: 10 }} />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      indicator="line"
                      formatter={(v, _n, item) => {
                        const r = (item as { payload?: PerHaBlockRow } | undefined)?.payload;
                        return `${judged(Number(v), r?.threshold)} · ${r?.cumulative ?? 0} over ${r?.areaHa ?? "?"} ha`;
                      }}
                    />
                  }
                />
                <Bar isAnimationActive={false} dataKey="perHa" radius={[3, 3, 3, 3]}>
                  {rows.map((r) => (
                    <Cell key={r.name} fill={r.over ? "var(--sd-data-red)" : "var(--sd-data-amber)"} />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>
          </RevealLTR>
        ) : (
          <EmptyHint title="Nothing recorded this week" hint="No block with an area was scouted in the current ISO week." />
        )}
        {noArea.length ? (
          <div data-testid="per-ha-no-area" className="mt-2 text-[0.7rem] text-muted-foreground">
            No area set, so no per-ha figure: {noArea.join(", ")}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
