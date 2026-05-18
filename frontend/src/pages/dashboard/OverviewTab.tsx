import { useState } from "react";
import {
  AreaChart,
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
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
import { Badge } from "@/components/ui/badge";
import { Kpi, KpiGrid } from "./Kpi";
import { EmptyHint } from "./EmptyHint";
import { GreenhouseModal } from "./GreenhouseModal";
import type { OverviewPayload } from "./overview-types";
import { weekTickFormatter } from "@/lib/iso-week";

const series: ChartConfig = {
  pests: { label: "Pests", color: "var(--sd-data-cyan)" },
  diseases: { label: "Diseases", color: "var(--sd-data-pink)" },
  traps: { label: "Traps", color: "var(--sd-data-purple)" },
};

const STATUS_DOT: Record<string, string> = {
  good: "bg-[var(--sd-data-green)]",
  warning: "bg-[var(--sd-target)]",
  critical: "bg-[var(--sd-data-red)]",
};

export function OverviewTab({
  data,
  scoutLookup,
  fromDate,
  toDate,
}: {
  data: OverviewPayload | null;
  scoutLookup: Record<string, string>;
  fromDate: string;
  toDate: string;
}) {
  const k = data?.kpis ?? { totalScouts: 0, zonesScouted: 0, greenhouseCount: 0, highAlerts: 0 };
  const daily = data?.daily ?? [];
  const totals = data
    ? [
        { name: "pests", value: data.rangeTotals.pests },
        { name: "diseases", value: data.rangeTotals.diseases },
        { name: "traps", value: data.rangeTotals.traps },
      ]
    : [
        { name: "pests", value: 0 },
        { name: "diseases", value: 0 },
        { name: "traps", value: 0 },
      ];
  const totalsMax = Math.max(1, totals.reduce((s, t) => s + t.value, 0));
  const ghs = data?.ghHealth ?? [];
  const scouts = (data?.topScouts ?? []).map((s) => ({
    ...s,
    name: s.scoutId,
    displayName: scoutLookup[s.scoutId] || s.scoutId,
  }));
  const recent = (data?.recentActivity ?? []).map((r) => ({
    ...r,
    scout: scoutLookup[r.scoutId] || r.scoutId,
  }));
  const alerts = data?.activeAlerts ?? [];
  const scoutsDaily = data?.scoutsPerDay ?? [];
  const perf = (data?.scoutPerformance ?? []).map((p) => ({
    ...p,
    name: scoutLookup[p.scoutId] || p.scoutId,
  }));
  const [openGh, setOpenGh] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <KpiGrid cols={4}>
        <Kpi
          label="Total Scouts"
          value={k.totalScouts}
          hint={
            scouts.length
              ? scouts.length > 4
                ? `${scouts.slice(0, 3).map((s) => s.displayName).join(", ")} + ${scouts.length - 3} more`
                : scouts.map((s) => s.displayName).join(", ")
              : "no scouts in range"
          }
        />
        <Kpi label="Zones Scouted" value={k.zonesScouted} hint="zone visits" />
        <Kpi
          label="Greenhouses"
          value={k.greenhouseCount}
          hint="monitored"
        />
        <Kpi
          label="High Alerts"
          value={k.highAlerts}
          tone={k.highAlerts > 0 ? "critical" : "default"}
          hint="critical levels"
        />
      </KpiGrid>

      <div className="grid grid-cols-1 lg:grid-cols-[3fr_1fr] gap-3">
        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Activity Timeline</CardTitle>
            <CardDescription>Daily observations</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {daily.length ? (
              <ChartContainer config={series} className="h-64">
                <AreaChart data={daily} margin={{ left: 4, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    interval={0}
                    minTickGap={0}
                    tickFormatter={weekTickFormatter}
                  />
                  <YAxis tickLine={false} axisLine={false} width={32} />
                  <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Area
                    type="linear"
                    dataKey="pests"
                    stackId="1"
                    stroke="var(--color-pests)"
                    fill="var(--color-pests)"
                    fillOpacity={0.18}
                  />
                  <Area
                    type="linear"
                    dataKey="diseases"
                    stackId="1"
                    stroke="var(--color-diseases)"
                    fill="var(--color-diseases)"
                    fillOpacity={0.18}
                  />
                  <Area
                    type="linear"
                    dataKey="traps"
                    stackId="1"
                    stroke="var(--color-traps)"
                    fill="var(--color-traps)"
                    fillOpacity={0.18}
                  />
                </AreaChart>
              </ChartContainer>
            ) : (
              <EmptyHint title="No timeline data" hint="No observations recorded in this range." />
            )}
          </CardContent>
        </Card>

        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Range Totals</CardTitle>
            <CardDescription>Category split</CardDescription>
          </CardHeader>
          <CardContent className="p-0 relative">
            {totalsMax > 1 ? (
              <>
                <ChartContainer config={series} className="h-56">
                  <PieChart>
                    <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                    <Pie
                      data={totals}
                      dataKey="value"
                      nameKey="name"
                      innerRadius="58%"
                      outerRadius="90%"
                      stroke="var(--sd-card)"
                      strokeWidth={2}
                    >
                      {totals.map((t) => (
                        <Cell key={t.name} fill={`var(--color-${t.name})`} />
                      ))}
                    </Pie>
                  </PieChart>
                </ChartContainer>
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="flex flex-col items-center">
                    <span className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                      Total
                    </span>
                    <span className="text-2xl font-semibold tabular-nums">
                      {totals.reduce((s, t) => s + t.value, 0)}
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <EmptyHint />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[3fr_1fr] gap-3">
        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Scouts Active Per Day</CardTitle>
            <CardDescription>Unique scouts contributing each day</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {scoutsDaily.length ? (
              <ChartContainer
                config={{ scouts: { label: "Scouts", color: "var(--sd-data-indigo)" } }}
                className="h-48"
              >
                <LineChart data={scoutsDaily} margin={{ left: 4, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    interval={0}
                    minTickGap={0}
                    tickFormatter={weekTickFormatter}
                  />
                  <YAxis tickLine={false} axisLine={false} width={28} />
                  <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                  <Line
                    type="linear"
                    dataKey="scouts"
                    stroke="var(--sd-data-indigo)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ChartContainer>
            ) : (
              <EmptyHint />
            )}
          </CardContent>
        </Card>

        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Active Alerts</CardTitle>
            <CardDescription>{alerts.length} flagged</CardDescription>
          </CardHeader>
          <CardContent className="p-0 flex flex-col gap-1.5">
            {alerts.length ? (
              alerts.map((a, i) => (
                <div
                  key={`${a.name}-${a.greenhouse}-${a.date}-${i}`}
                  className="flex flex-col gap-1 px-3 py-2 rounded-md border bg-[var(--sd-bg-soft)]"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{a.name}</span>
                    <Badge
                      variant={a.severity === "high" ? "destructive" : "secondary"}
                      className="text-[0.6rem]"
                    >
                      {a.severity}
                    </Badge>
                  </div>
                  <div className="text-[0.7rem] text-muted-foreground truncate">
                    {a.greenhouse}
                    {a.zone ? ` · ${a.zone}` : ""}
                  </div>
                </div>
              ))
            ) : (
              <EmptyHint title="No active alerts" hint="No high-severity observations." />
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="p-4">
        <CardHeader className="p-0 pb-2">
          <CardTitle>Scout Performance</CardTitle>
          <CardDescription>Zones · pests · diseases per scout</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {perf.length ? (
            <ChartContainer
              config={{
                zones: { label: "Zones", color: "var(--sd-data-cyan)" },
                pests: { label: "Pests", color: "var(--sd-data-amber)" },
                diseases: { label: "Diseases", color: "var(--sd-data-pink)" },
              }}
              className="h-64"
            >
              <BarChart data={perf} margin={{ left: 12, right: 12, top: 8 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="name"
                  tickLine={false}
                  axisLine={false}
                  interval={0}
                  height={48}
                  tick={{ fontSize: 10 }}
                />
                <YAxis tickLine={false} axisLine={false} width={32} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="zones" fill="var(--sd-data-cyan)" radius={[3, 3, 0, 0]} />
                <Bar dataKey="pests" fill="var(--sd-data-amber)" radius={[3, 3, 0, 0]} />
                <Bar dataKey="diseases" fill="var(--sd-data-pink)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ChartContainer>
          ) : (
            <EmptyHint />
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Greenhouse Health</CardTitle>
            <CardDescription>{ghs.length} monitored · click for details</CardDescription>
          </CardHeader>
          <CardContent className="p-0 flex flex-col gap-1.5">
            {ghs.length ? (
              ghs.slice(0, 12).map((g) => (
                <button
                  type="button"
                  key={g.name}
                  onClick={() => setOpenGh(g.name)}
                  className="flex items-center justify-between gap-3 px-3 py-2 rounded-md border bg-[var(--sd-bg-soft)] hover:bg-[var(--sd-pistachio)] transition-colors text-left"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`h-2 w-2 rounded-full ${STATUS_DOT[g.status]}`} />
                    <span className="font-medium text-sm text-foreground truncate">
                      {g.name}
                    </span>
                    {g.alerts > 0 && (
                      <Badge variant="destructive" className="ml-1 text-[0.65rem]">
                        {g.alerts} alert{g.alerts !== 1 ? "s" : ""}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
                    <span>{g.pests}p</span>
                    <span>{g.diseases}d</span>
                    <span>{g.traps}t</span>
                    <span>{g.scoutCount}s</span>
                  </div>
                </button>
              ))
            ) : (
              <EmptyHint title="No greenhouses" />
            )}
          </CardContent>
        </Card>

        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Recent Zone Activity</CardTitle>
            <CardDescription>Most recent zone visits</CardDescription>
          </CardHeader>
          <CardContent className="p-0 flex flex-col gap-1.5">
            {recent.length ? (
              recent.map((r) => (
                <div
                  key={r.name}
                  className="flex items-center justify-between gap-3 px-3 py-2 rounded-md border bg-[var(--sd-bg-soft)]"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">
                      {r.greenhouse}
                      {r.zone && (
                        <span className="text-muted-foreground"> · {r.zone}</span>
                      )}
                    </div>
                    <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                      {r.kind}
                      {r.scout && <span className="ml-1">· {r.scout}</span>}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground font-mono tabular-nums">
                    {r.date}
                  </div>
                </div>
              ))
            ) : (
              <EmptyHint />
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="p-4">
        <CardHeader className="p-0 pb-2">
          <CardTitle>Top Scouts</CardTitle>
          <CardDescription>By zone visits</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {scouts.length ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
              {scouts.map((s, i) => (
                <div
                  key={s.name}
                  className="flex items-center gap-3 px-3 py-2 rounded-md border bg-[var(--sd-bg-soft)]"
                >
                  <div
                    className={`h-7 w-7 rounded-full flex items-center justify-center text-[0.72rem] font-semibold tabular-nums ${
                      i === 0
                        ? "bg-[var(--sd-target)] text-white"
                        : i === 1
                          ? "bg-[var(--sd-data-cyan)] text-white"
                          : i === 2
                            ? "bg-[var(--sd-data-purple)] text-white"
                            : "bg-secondary text-secondary-foreground"
                    }`}
                  >
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {s.displayName}
                    </div>
                    <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                      {s.entries} zones
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyHint />
          )}
        </CardContent>
      </Card>

      <GreenhouseModal
        data={null as any}
        greenhouse={openGh}
        open={!!openGh}
        onOpenChange={(v) => !v && setOpenGh(null)}
        fromDate={fromDate}
        toDate={toDate}
      />
    </div>
  );
}
