import { useMemo } from "react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  XAxis,
  YAxis,
} from "recharts"
import { Sprout } from "lucide-react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"

import { EmptyHint } from "./EmptyHint"
import { Kpi } from "./Kpi"
import type { AggregatedScouting } from "./aggregate"

interface Props {
  data: AggregatedScouting
  loading: boolean
}

export function OverviewTab({ data, loading }: Props) {
  const timelineData = useMemo(
    () =>
      data.daily.map((d) => ({
        date: d.date.slice(5),
        Pests: d.pests,
        Diseases: d.diseases,
        Traps: d.traps,
      })),
    [data.daily],
  )

  const timelineConfig = {
    Pests: { label: "Pests", color: "var(--chart-1)" },
    Diseases: { label: "Diseases", color: "var(--chart-3)" },
    Traps: { label: "Traps", color: "var(--chart-2)" },
  } satisfies ChartConfig

  const donut = useMemo(
    () =>
      [
        { key: "pests", label: "Pests", count: data.totalPestObservations, fill: "var(--chart-1)" },
        { key: "diseases", label: "Diseases", count: data.totalDiseaseObservations, fill: "var(--chart-3)" },
        { key: "traps", label: "Traps", count: data.totalTrapObservations, fill: "var(--chart-2)" },
      ].filter((d) => d.count > 0),
    [data.totalPestObservations, data.totalDiseaseObservations, data.totalTrapObservations],
  )
  const donutTotal = donut.reduce((s, d) => s + d.count, 0)
  const donutConfig = {
    count: { label: "Observations" },
    pests: { label: "Pests", color: "var(--chart-1)" },
    diseases: { label: "Diseases", color: "var(--chart-3)" },
    traps: { label: "Traps", color: "var(--chart-2)" },
  } satisfies ChartConfig

  const topPests = useMemo(
    () => data.pests.slice(0, 6).map((p) => ({ name: p.name, total: p.total })),
    [data.pests],
  )
  const topDiseases = useMemo(
    () => data.diseases.slice(0, 6).map((d) => ({ name: d.name, total: d.total })),
    [data.diseases],
  )
  const topPestsConfig = {
    total: { label: "Observations", color: "var(--chart-1)" },
  } satisfies ChartConfig
  const topDiseasesConfig = {
    total: { label: "Observations", color: "var(--chart-3)" },
  } satisfies ChartConfig

  const topGreenhouses = useMemo(
    () =>
      data.greenhouses.slice(0, 8).map((g) => ({
        greenhouse: g.name,
        observations: g.pests + g.diseases + g.traps,
        alerts: g.alerts,
      })),
    [data.greenhouses],
  )
  const ghConfig = {
    observations: { label: "Observations", color: "var(--chart-1)" },
  } satisfies ChartConfig

  const topScouts = useMemo(() => data.scouts.slice(0, 8), [data.scouts])

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Kpi label="Entries" value={data.totalEntries.toString()} hint="this period" />
        <Kpi
          label="Pest observations"
          value={data.totalPestObservations.toString()}
          hint={`${data.pests.length} unique`}
          accent="chart-1"
        />
        <Kpi
          label="Disease observations"
          value={data.totalDiseaseObservations.toString()}
          hint={`${data.diseases.length} unique`}
          accent="chart-3"
        />
        <Kpi
          label="Trap counts"
          value={data.totalTrapObservations.toString()}
          hint={`${data.traps.length} traps`}
          accent="chart-2"
        />
        <Kpi
          label="Alerts"
          value={data.totalAlerts.toString()}
          hint="trap > 10"
          accent="severity-high"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Daily timeline</CardTitle>
            <CardDescription>Pests, diseases, traps by capture date</CardDescription>
          </CardHeader>
          <CardContent>
            {timelineData.length === 0 ? (
              <EmptyHint loading={loading}>No entries in the selected range.</EmptyHint>
            ) : (
              <ChartContainer config={timelineConfig} className="aspect-[16/6] w-full">
                <AreaChart
                  data={timelineData}
                  margin={{ left: 8, right: 8, top: 12, bottom: 0 }}
                >
                  <defs>
                    {(["Pests", "Diseases", "Traps"] as const).map((k) => (
                      <linearGradient key={k} id={`fill${k}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={`var(--color-${k})`} stopOpacity={0.45} />
                        <stop offset="95%" stopColor={`var(--color-${k})`} stopOpacity={0} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} />
                  <YAxis tickLine={false} axisLine={false} width={32} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Area
                    dataKey="Pests"
                    type="monotone"
                    fill="url(#fillPests)"
                    stroke="var(--color-Pests)"
                    strokeWidth={2}
                    stackId="a"
                  />
                  <Area
                    dataKey="Diseases"
                    type="monotone"
                    fill="url(#fillDiseases)"
                    stroke="var(--color-Diseases)"
                    strokeWidth={2}
                    stackId="a"
                  />
                  <Area
                    dataKey="Traps"
                    type="monotone"
                    fill="url(#fillTraps)"
                    stroke="var(--color-Traps)"
                    strokeWidth={2}
                    stackId="a"
                  />
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Observations split</CardTitle>
            <CardDescription>
              Total {donutTotal.toLocaleString()} observations
            </CardDescription>
          </CardHeader>
          <CardContent>
            {donutTotal === 0 ? (
              <EmptyHint loading={loading}>No observations in this period.</EmptyHint>
            ) : (
              <ChartContainer config={donutConfig} className="mx-auto aspect-square max-h-[260px]">
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                  <Pie data={donut} dataKey="count" nameKey="label" innerRadius={60} strokeWidth={4}>
                    {donut.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Pie>
                  <ChartLegend content={<ChartLegendContent nameKey="label" />} />
                </PieChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top pests</CardTitle>
            <CardDescription>Top 6 by observation count</CardDescription>
          </CardHeader>
          <CardContent>
            {topPests.length === 0 ? (
              <EmptyHint loading={loading}>No pest observations.</EmptyHint>
            ) : (
              <ChartContainer
                config={topPestsConfig}
                className="mx-auto aspect-square max-h-[300px]"
              >
                <RadarChart data={topPests}>
                  <PolarGrid />
                  <PolarAngleAxis dataKey="name" />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Radar
                    dataKey="total"
                    fill="var(--color-total)"
                    fillOpacity={0.5}
                    stroke="var(--color-total)"
                    strokeWidth={2}
                  />
                </RadarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top diseases</CardTitle>
            <CardDescription>Top 6 by observation count</CardDescription>
          </CardHeader>
          <CardContent>
            {topDiseases.length === 0 ? (
              <EmptyHint loading={loading}>No disease observations.</EmptyHint>
            ) : (
              <ChartContainer
                config={topDiseasesConfig}
                className="mx-auto aspect-square max-h-[300px]"
              >
                <RadarChart data={topDiseases}>
                  <PolarGrid />
                  <PolarAngleAxis dataKey="name" />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Radar
                    dataKey="total"
                    fill="var(--color-total)"
                    fillOpacity={0.5}
                    stroke="var(--color-total)"
                    strokeWidth={2}
                  />
                </RadarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Greenhouse activity</CardTitle>
            <CardDescription>Top 8 by total observations</CardDescription>
          </CardHeader>
          <CardContent>
            {topGreenhouses.length === 0 ? (
              <EmptyHint loading={loading}>No greenhouse data.</EmptyHint>
            ) : (
              <ChartContainer config={ghConfig} className="aspect-[16/8] w-full">
                <BarChart data={topGreenhouses} layout="vertical" margin={{ left: 8 }}>
                  <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                  <XAxis type="number" tickLine={false} axisLine={false} />
                  <YAxis
                    dataKey="greenhouse"
                    type="category"
                    tickLine={false}
                    axisLine={false}
                    width={120}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar
                    dataKey="observations"
                    fill="var(--color-observations)"
                    radius={[0, 6, 6, 0]}
                  />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top scouts</CardTitle>
            <CardDescription>By number of submitted entries</CardDescription>
          </CardHeader>
          <CardContent>
            {topScouts.length === 0 ? (
              <EmptyHint loading={loading}>No scout data.</EmptyHint>
            ) : (
              <ul className="space-y-2 text-sm">
                {topScouts.map((s) => {
                  const obs =
                    s.pestObservations + s.diseaseObservations + s.trapObservations
                  return (
                    <li
                      key={s.key}
                      className="flex items-center gap-3 rounded-md border bg-card px-3 py-2"
                    >
                      <Sprout className="size-4 text-muted-foreground" />
                      <div className="flex-1">
                        <div className="font-medium">{s.label}</div>
                        <div className="text-xs text-muted-foreground">
                          {s.entries} entries · {obs} observations
                        </div>
                      </div>
                      <Badge variant="secondary" className="font-normal">
                        {obs}
                      </Badge>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
