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
import { Kpi, KpiGrid } from "./Kpi";
import { EmptyHint } from "./EmptyHint";
import { DashFilterRow } from "./DashFilterRow";
import { stagesFor, type PestsPayload } from "./pests-diseases-types";
import { weekTickFormatter } from "@/lib/iso-week";

export interface PestsTabProps {
  data: PestsPayload | null;
  pestName: string;       // page-level filter (the "observation" filter)
  section: string;
  stage: string;
  onFiltersChange: (next: { observation: string; section: string; stage: string }) => void;
}

export function PestsTab({
  data,
  pestName,
  section,
  stage,
  onFiltersChange,
}: PestsTabProps) {
  const { pest: pestColor } = useObservationColors();

  const opts = data?.filterOptions ?? { pests: [], sections: [], stages: [] };
  const ranking = data?.ranking ?? [];
  const trendRows = data?.dailyPercent ?? [];
  const distribution = data?.distribution ?? [];
  const sectionSplit = data?.sectionSplit ?? [];
  const ghPressure = data?.greenhousePressure ?? [];

  const trend = { rows: trendRows, pestName: pestName || "All pests" };

  const total = ranking.reduce((s, r) => s + r.total, 0);
  const high = ranking.reduce((s, r) => s + r.high, 0);
  const top = ranking[0];

  const lineConfig: ChartConfig = useMemo(
    () => ({ value: { label: trend.pestName, color: "var(--sd-data-cyan)" } }),
    [trend.pestName],
  );
  const distConfig: ChartConfig = {
    pct: { label: "% zones", color: "var(--sd-data-cyan)" },
  };

  // Offer only the stages the selected pest actually has. Picking a pest used
  // to leave every stage in the dataset on the menu, including ones belonging
  // to diseases.
  const stageOptions = stagesFor(opts, pestName);
  // A stage carried over from a previous pest may not exist for this one, which
  // would silently filter the chart to nothing. Drop it back to "all".
  const effectiveStage = stage && stageOptions.includes(stage) ? stage : "";
  useEffect(() => {
    if (stage && stage !== effectiveStage) {
      onFiltersChange({ observation: pestName, section, stage: "" });
    }
  }, [stage, effectiveStage, pestName, section, onFiltersChange]);

  const filters = { observation: pestName, section, stage: effectiveStage };

  return (
    <div className="flex flex-col gap-4">
      <KpiGrid cols={4}>
        <Kpi label="Pest Zones" value={ranking.length} hint="distinct pests recorded" />
        <Kpi label="Active Pests" value={total} hint="observations" />
        <Kpi
          label="High Severity"
          value={high}
          tone={high > 0 ? "critical" : "default"}
          hint="critical observations"
        />
        <Kpi
          label="Top Pest"
          value={top?.name || "—"}
          hint={top ? `${top.total} observations` : "no pests recorded"}
        />
      </KpiGrid>

      <Card className="p-4">
        <CardHeader className="p-0 pb-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <CardTitle>Pest Trends</CardTitle>
              <CardDescription>
                {trend.pestName} · zones infected (%) · daily data points
              </CardDescription>
            </div>
            <DashFilterRow
              obsLabel="Pest"
              obsOptions={opts.pests}
              sectionOptions={opts.sections}
              stageOptions={stageOptions}
              value={filters}
              onChange={onFiltersChange}
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
                      formatter={(v) => `${v}%`}
                    />
                  }
                />
                <Line
                  type="linear"
                  dataKey="value"
                  stroke="var(--sd-data-cyan)"
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
            <CardTitle>Pest Distribution</CardTitle>
            <CardDescription>% of zones in scope with each pest</CardDescription>
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
                  <Bar dataKey="pct" radius={[3, 3, 3, 3]}>
                    {distribution.slice(0, 12).map((row) => (
                      <Cell key={row.name} fill={pestColor(row.name)} />
                    ))}
                  </Bar>
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
            <CardDescription>Where pests are concentrated (% of pest zones)</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {sectionSplit.length ? (
              <ChartContainer config={distConfig} className="h-72">
                <BarChart
                  data={sectionSplit}
                  margin={{ left: 12, right: 12, top: 8 }}
                >
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
            <CardTitle>Severity Matrix</CardTitle>
            <CardDescription>Per pest · low / moderate / high</CardDescription>
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
                        <div className="text-sm font-medium truncate flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 rounded-full shrink-0 border"
                            style={{ background: pestColor(r.name) }}
                            aria-hidden
                          />
                          <span className="truncate">{r.name}</span>
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
            <CardTitle>Pest Pressure by Greenhouse</CardTitle>
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

