import type { KpiSeries } from "./Sparkline";
import { useEffect, useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import { useObservationColors } from "@/lib/observation-colors";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RevealLTR } from "@/components/RevealLTR";
import { ChartSkeleton } from "@/components/Loading";
import { Kpi, KpiGrid } from "./Kpi";
import { CardRowsSkeleton } from "./slot-skeletons";
import { EmptyHint } from "./EmptyHint";
import { DashFilterRow } from "./DashFilterRow";
import { PrevalenceFigure } from "./PrevalenceFigure";
import { stagesFor, type DiseasesPayload } from "./pests-diseases-types";
import { weekTickFormatter } from "@/lib/iso-week";
import { ObservationName } from "@/components/gallery/ObservationGallery";

export interface DiseasesTabProps {
  data: DiseasesPayload | null;
  diseaseName: string;    // page-level filter (the "observation" filter)
  section: string;
  stage: string;
  onFiltersChange: (next: { observation: string; section: string; stage: string }) => void;
  /** First load (no payload yet): the cards stand, their contents are skeletons. */
  /** Weekly series for the KPI sparklines (kpi_series aggregate). */
  series?: KpiSeries;
  loading?: boolean;
}

export function DiseasesTab({
  data,
  diseaseName,
  section,
  stage,
  onFiltersChange,
  series,
  loading = false,
}: DiseasesTabProps) {
  const { disease: diseaseColor } = useObservationColors();

  const opts = data?.filterOptions ?? { diseases: [], sections: [], stages: [] };
  const ranking = data?.ranking ?? [];
  const trendRows = data?.dailyPercent ?? [];
  const distribution = data?.distribution ?? [];
  const sectionSplit = data?.sectionSplit ?? [];
  const ghPressure = data?.greenhousePressure ?? [];

  const trend = { rows: trendRows, diseaseName: diseaseName || "All diseases" };

  const total = ranking.reduce((s, r) => s + r.total, 0);
  const severe = ranking.reduce((s, r) => s + r.high, 0);
  const top = ranking[0];

  const lineConfig: ChartConfig = useMemo(
    () => ({ value: { label: trend.diseaseName, color: "var(--sd-data-pink)" } }),
    [trend.diseaseName],
  );
  const distConfig: ChartConfig = {
    pct: { label: "% scouted (adjusted)", color: "var(--sd-data-pink)" },
  };

  // Only the stages this disease actually has — see PestsTab.
  const stageOptions = stagesFor(opts, diseaseName);
  const effectiveStage = stage && stageOptions.includes(stage) ? stage : "";
  useEffect(() => {
    if (stage && stage !== effectiveStage) {
      onFiltersChange({ observation: diseaseName, section, stage: "" });
    }
  }, [stage, effectiveStage, diseaseName, section, onFiltersChange]);

  const filters = { observation: diseaseName, section, stage: effectiveStage };

  return (
    <div className="flex flex-col gap-4" aria-busy={loading || undefined}>
      <KpiGrid cols={4}>
        <Kpi loading={loading} series={series?.diseaseKinds} label="Disease Zones" value={ranking.length} hint="distinct diseases" />
        <Kpi loading={loading} series={series?.diseases} label="Active Diseases" value={total} hint="incidents" />
        <Kpi
          loading={loading}
          label="Severe Cases"
          value={severe}
          tone={severe > 0 ? "critical" : "default"}
          hint="high-severity"
        />
        <Kpi
          loading={loading}
          label="Top Disease"
          value={top?.name || "—"}
          hint={top ? `${top.total} incidents` : "no diseases recorded"}
        />
      </KpiGrid>

      <Card className="p-4">
        <CardHeader className="p-0 pb-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <CardTitle>Disease Trends</CardTitle>
              <CardDescription>
                {trend.diseaseName} · adjusted prevalence (% of scouted stations) · weekly
              </CardDescription>
            </div>
            <DashFilterRow
              obsLabel="Disease"
              obsOptions={opts.diseases}
              sectionOptions={opts.sections}
              stageOptions={stageOptions}
              value={filters}
              onChange={onFiltersChange}
              disabled={loading}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <ChartSkeleton height={256} />
          ) : trend.rows.length ? (
            <RevealLTR>
              <ChartContainer config={lineConfig} className="h-64">
                <LineChart data={trend.rows} margin={{ left: 4, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    interval={0}
                    minTickGap={0}
                    tickFormatter={weekTickFormatter}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={36}
                    tickFormatter={(v: number) => `${v}%`}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        indicator="line"
                        formatter={(v) => (v == null ? "—" : `${v}%`)}
                      />
                    }
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="var(--sd-data-pink)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                    connectNulls
                    isAnimationActive={false}
                  />
                </LineChart>
              </ChartContainer>
            </RevealLTR>
          ) : (
            <EmptyHint title="Not observed in this range" hint="Try a wider date range or different filter." />
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Disease Distribution</CardTitle>
            <CardDescription>Adjusted prevalence across the scope · latest scouted week</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <ChartSkeleton height={288} />
            ) : distribution.length ? (
              <RevealLTR>
                <ChartContainer config={distConfig} className="h-72">
                  <BarChart
                    data={distribution.slice(0, 12)}
                    layout="vertical"
                    margin={{ left: 12, right: 12 }}
                  >
                    <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                    <XAxis
                      type="number"
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: number) => `${v}%`}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      tickLine={false}
                      axisLine={false}
                      width={120}
                    />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          indicator="line"
                          formatter={(v) => (v == null ? "—" : `${v}%`)}
                        />
                      }
                    />
                    <Bar isAnimationActive={false} dataKey="pct" radius={[3, 3, 3, 3]}>
                      {distribution.slice(0, 12).map((row) => (
                        <Cell key={row.name} fill={diseaseColor(row.name)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ChartContainer>
              </RevealLTR>
            ) : (
              <EmptyHint />
            )}
          </CardContent>
        </Card>

        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Plant Section Split</CardTitle>
            <CardDescription>
              Where diseases are concentrated (% of disease zones)
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <ChartSkeleton height={288} />
            ) : sectionSplit.length ? (
              <RevealLTR>
                <ChartContainer config={distConfig} className="h-72">
                  <BarChart data={sectionSplit} margin={{ left: 12, right: 12, top: 8 }}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis dataKey="name" tickLine={false} axisLine={false} />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      width={36}
                      tickFormatter={(v: number) => `${v}%`}
                    />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          indicator="line"
                          formatter={(v) => (v == null ? "—" : `${v}%`)}
                        />
                      }
                    />
                    <Bar isAnimationActive={false} dataKey="pct" fill="var(--sd-data-purple)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ChartContainer>
              </RevealLTR>
            ) : (
              <EmptyHint />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Severity Levels</CardTitle>
            <CardDescription>Per disease · high · moderate · low</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <CardRowsSkeleton rows={6} twoLine />
            ) : ranking.length ? (
              <div className="flex flex-col gap-1.5">
                {ranking.slice(0, 8).map((r) => {
                  const tot = Math.max(1, r.high + r.moderate + r.low);
                  return (
                    <div
                      key={r.name}
                      className="grid grid-cols-[1fr_auto] gap-3 items-center px-3 py-2 rounded-md border bg-[var(--sd-bg-soft)]"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 rounded-full shrink-0 border"
                            style={{ background: diseaseColor(r.name) }}
                            aria-hidden
                          />
                          <ObservationName kind="disease" name={r.name} className="truncate" />
                        </div>
                        <div className="mt-1.5 h-2 rounded-full overflow-hidden bg-[var(--sd-line)] flex">
                          <div
                            className="h-full bg-[var(--sd-data-red)]"
                            style={{ width: `${(r.high / tot) * 100}%` }}
                          />
                          <div
                            className="h-full bg-[var(--sd-target)]"
                            style={{ width: `${(r.moderate / tot) * 100}%` }}
                          />
                          <div
                            className="h-full bg-[var(--sd-data-green)]"
                            style={{ width: `${(r.low / tot) * 100}%` }}
                          />
                        </div>
                        <PrevalenceFigure fig={r} className="mt-1" />
                      </div>
                      <div className="text-xs text-muted-foreground tabular-nums flex gap-3">
                        <span className="text-[var(--sd-data-red)]">{r.high}</span>
                        <span className="text-[var(--sd-target)]">{r.moderate}</span>
                        <span className="text-[var(--sd-data-green)]">{r.low}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyHint />
            )}
          </CardContent>
        </Card>

        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Disease Pressure by Greenhouse</CardTitle>
            <CardDescription>Adjusted prevalence · each greenhouse's latest scouted week</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <ChartSkeleton height={288} />
            ) : ghPressure.length ? (
              <RevealLTR>
                <ChartContainer config={distConfig} className="h-72">
                  <BarChart
                    data={ghPressure.slice(0, 12)}
                    layout="vertical"
                    margin={{ left: 12, right: 12 }}
                  >
                    <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                    <XAxis
                      type="number"
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: number) => `${v}%`}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      tickLine={false}
                      axisLine={false}
                      width={140}
                      tick={{ fontSize: 10 }}
                    />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          indicator="line"
                          formatter={(v) => (v == null ? "—" : `${v}%`)}
                        />
                      }
                    />
                    <Bar isAnimationActive={false} dataKey="pct" fill="var(--sd-data-amber)" radius={[3, 3, 3, 3]} />
                  </BarChart>
                </ChartContainer>
              </RevealLTR>
            ) : (
              <EmptyHint />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
