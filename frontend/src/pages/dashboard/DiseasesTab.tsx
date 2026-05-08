import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
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
import { Kpi, KpiGrid } from "./Kpi";
import { EmptyHint } from "./EmptyHint";
import { DashFilterRow } from "./DashFilterRow";
import {
  ALL_FILTER,
  diseaseDailyPercent,
  diseaseDistributionPercent,
  diseaseFilterOptions,
  diseaseRanking,
  diseaseSectionPercent,
  greenhousePressurePercent,
  type DashFilters,
} from "./aggregate";
import type { ProcessedData } from "@/lib/scouting-types";

export function DiseasesTab({
  data,
  zonesByGreenhouse,
}: {
  data: ProcessedData | null;
  zonesByGreenhouse: Record<string, number>;
}) {
  const [filters, setFilters] = useState<DashFilters>({
    observation: ALL_FILTER,
    section: ALL_FILTER,
    stage: ALL_FILTER,
  });
  const opts = useMemo(() => diseaseFilterOptions(data), [data]);
  const ranking = useMemo(() => diseaseRanking(data), [data]);
  const trend = useMemo(
    () => diseaseDailyPercent(data, zonesByGreenhouse, filters),
    [data, zonesByGreenhouse, filters],
  );
  const distribution = useMemo(
    () => diseaseDistributionPercent(data, zonesByGreenhouse, filters),
    [data, zonesByGreenhouse, filters],
  );
  const sectionSplit = useMemo(
    () => diseaseSectionPercent(data, filters),
    [data, filters],
  );
  const ghPressure = useMemo(
    () => greenhousePressurePercent(data, zonesByGreenhouse, "disease", filters),
    [data, zonesByGreenhouse, filters],
  );

  const total = ranking.reduce((s, r) => s + r.total, 0);
  const severe = ranking.reduce((s, r) => s + r.high, 0);
  const top = ranking[0];

  const lineConfig: ChartConfig = {
    value: { label: trend.diseaseName, color: "var(--sd-data-pink)" },
  };
  const distConfig: ChartConfig = {
    pct: { label: "% zones", color: "var(--sd-data-pink)" },
  };

  return (
    <div className="flex flex-col gap-4">
      <KpiGrid cols={4}>
        <Kpi label="Disease Zones" value={ranking.length} hint="distinct diseases" />
        <Kpi label="Active Diseases" value={total} hint="incidents" />
        <Kpi
          label="Severe Cases"
          value={severe}
          tone={severe > 0 ? "critical" : "default"}
          hint="high-severity"
        />
        <Kpi
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
                {trend.diseaseName} · zones infected (%) · daily data points
              </CardDescription>
            </div>
            <DashFilterRow
              obsLabel="Disease"
              obsOptions={opts.diseases}
              sectionOptions={opts.sections}
              stageOptions={opts.stages}
              value={filters}
              onChange={setFilters}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {trend.rows.length ? (
            <ChartContainer config={lineConfig} className="h-64">
              <LineChart data={trend.rows} margin={{ left: 4, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={30}
                  tickFormatter={(v: string) => v.slice(5)}
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
                      formatter={(v) => `${v}%`}
                    />
                  }
                />
                <Line
                  type="linear"
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
          ) : (
            <EmptyHint title="Not observed in this range" hint="Try a wider date range or different filter." />
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Disease Distribution</CardTitle>
            <CardDescription>% of zones in scope with each disease</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {distribution.length ? (
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
                        formatter={(v) => `${v}%`}
                      />
                    }
                  />
                  <Bar dataKey="pct" fill="var(--sd-data-pink)" radius={[3, 3, 3, 3]} />
                </BarChart>
              </ChartContainer>
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
            {sectionSplit.length ? (
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
                        formatter={(v) => `${v}%`}
                      />
                    }
                  />
                  <Bar dataKey="pct" fill="var(--sd-data-purple)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ChartContainer>
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
            {ranking.length ? (
              <div className="flex flex-col gap-1.5">
                {ranking.slice(0, 8).map((r) => {
                  const tot = Math.max(1, r.high + r.moderate + r.low);
                  return (
                    <div
                      key={r.name}
                      className="grid grid-cols-[1fr_auto] gap-3 items-center px-3 py-2 rounded-md border bg-[var(--sd-bg-soft)]"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{r.name}</div>
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
            <CardDescription>% zones infected per greenhouse</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {ghPressure.length ? (
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
                        formatter={(v) => `${v}%`}
                      />
                    }
                  />
                  <Bar dataKey="pct" fill="var(--sd-data-amber)" radius={[3, 3, 3, 3]} />
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyHint />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
