import { useMemo } from "react"
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"

import { EmptyHint } from "./EmptyHint"
import { Kpi } from "./Kpi"
import type { AggregatedScouting } from "./aggregate"

interface Props {
  data: AggregatedScouting
  loading: boolean
}

export function PestsTab({ data, loading }: Props) {
  const totalEntries = data.totalEntries
  const totalPestObs = data.totalPestObservations
  const activePests = data.pests.length
  const highSeverity = data.pests.reduce((s, p) => s + p.severity.high, 0)
  const top = data.pests[0]

  const topPestsBar = useMemo(
    () => data.pests.slice(0, 10).map((p) => ({ name: p.name, total: p.total })),
    [data.pests],
  )
  const topPestsConfig = {
    total: { label: "Observations", color: "var(--chart-1)" },
  } satisfies ChartConfig

  // Section split (aggregated across all pests, or top pest if available)
  const sectionData = useMemo(() => {
    const totals: Record<string, number> = {}
    for (const p of data.pests) {
      for (const [section, n] of Object.entries(p.sections)) {
        totals[section] = (totals[section] || 0) + n
      }
    }
    return Object.entries(totals)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
  }, [data.pests])
  const SECTION_COLORS = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)",
  ]
  const sectionConfig = {
    count: { label: "Observations" },
  } satisfies ChartConfig

  // Severity breakdown across all pests
  const severityData = useMemo(() => {
    const sums = data.pests.reduce(
      (acc, p) => {
        acc.low += p.severity.low
        acc.moderate += p.severity.moderate
        acc.high += p.severity.high
        return acc
      },
      { low: 0, moderate: 0, high: 0 },
    )
    return [
      { level: "Low", count: sums.low, fill: "var(--severity-low)" },
      { level: "Moderate", count: sums.moderate, fill: "var(--severity-mod)" },
      { level: "High", count: sums.high, fill: "var(--severity-high)" },
    ].filter((d) => d.count > 0)
  }, [data.pests])
  const severityConfig = {
    count: { label: "Observations" },
    low: { label: "Low", color: "var(--severity-low)" },
    moderate: { label: "Moderate", color: "var(--severity-mod)" },
    high: { label: "High", color: "var(--severity-high)" },
  } satisfies ChartConfig

  // Greenhouse pressure (ranked by pest observations)
  const ghPressure = useMemo(
    () =>
      data.greenhouses
        .map((g) => ({ greenhouse: g.name, pests: g.pests }))
        .filter((g) => g.pests > 0)
        .sort((a, b) => b.pests - a.pests)
        .slice(0, 10),
    [data.greenhouses],
  )
  const ghConfig = {
    pests: { label: "Pest obs", color: "var(--chart-1)" },
  } satisfies ChartConfig

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Total entries" value={totalEntries.toString()} accent="chart-2" />
        <Kpi
          label="Pest observations"
          value={totalPestObs.toString()}
          accent="chart-1"
          hint={`${activePests} unique`}
        />
        <Kpi
          label="High severity"
          value={highSeverity.toString()}
          accent="severity-high"
          hint="count > 15"
        />
        <Kpi
          label="Top pest"
          value={top ? top.name : "—"}
          hint={top ? `${top.total} observations` : "no data"}
          accent="chart-3"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Top pests</CardTitle>
          <CardDescription>Top 10 pests by observation count</CardDescription>
        </CardHeader>
        <CardContent>
          {topPestsBar.length === 0 ? (
            <EmptyHint loading={loading}>No pest observations.</EmptyHint>
          ) : (
            <ChartContainer config={topPestsConfig} className="aspect-[16/6] w-full">
              <BarChart data={topPestsBar} margin={{ left: 8, right: 8 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="name"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  interval={0}
                  angle={-25}
                  height={70}
                  textAnchor="end"
                />
                <YAxis tickLine={false} axisLine={false} width={32} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="total" fill="var(--color-total)" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Plant section split</CardTitle>
            <CardDescription>Where pests are found</CardDescription>
          </CardHeader>
          <CardContent>
            {sectionData.length === 0 ? (
              <EmptyHint loading={loading}>No section data.</EmptyHint>
            ) : (
              <ChartContainer
                config={sectionConfig}
                className="mx-auto aspect-square max-h-[260px]"
              >
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                  <Pie
                    data={sectionData}
                    dataKey="count"
                    nameKey="name"
                    innerRadius={50}
                    strokeWidth={3}
                  >
                    {sectionData.map((_, i) => (
                      <Cell key={i} fill={SECTION_COLORS[i % SECTION_COLORS.length]} />
                    ))}
                  </Pie>
                  <ChartLegend content={<ChartLegendContent nameKey="name" />} />
                </PieChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Severity matrix</CardTitle>
            <CardDescription>Aggregate severity buckets</CardDescription>
          </CardHeader>
          <CardContent>
            {severityData.length === 0 ? (
              <EmptyHint loading={loading}>No severity data.</EmptyHint>
            ) : (
              <ChartContainer config={severityConfig} className="aspect-[16/9] w-full">
                <BarChart data={severityData} margin={{ left: 8 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="level" tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} width={32} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                    {severityData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pest pressure by greenhouse</CardTitle>
            <CardDescription>Top 10 greenhouses by pest observations</CardDescription>
          </CardHeader>
          <CardContent>
            {ghPressure.length === 0 ? (
              <EmptyHint loading={loading}>No greenhouse data.</EmptyHint>
            ) : (
              <ChartContainer config={ghConfig} className="aspect-[16/9] w-full">
                <BarChart data={ghPressure} layout="vertical" margin={{ left: 8 }}>
                  <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                  <XAxis type="number" tickLine={false} axisLine={false} />
                  <YAxis
                    dataKey="greenhouse"
                    type="category"
                    tickLine={false}
                    axisLine={false}
                    width={110}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="pests" fill="var(--color-pests)" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pest stages</CardTitle>
          <CardDescription>Per-pest stage breakdown (top 10 by total)</CardDescription>
        </CardHeader>
        <CardContent>
          {data.pests.length === 0 ? (
            <EmptyHint loading={loading}>No pest stage data.</EmptyHint>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pest</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Stages</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.pests.slice(0, 10).map((p) => (
                  <TableRow key={p.name}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.total}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(p.stages)
                          .sort((a, b) => b[1] - a[1])
                          .map(([stage, count]) => (
                            <Badge
                              key={stage}
                              variant="secondary"
                              className="font-normal"
                            >
                              {stage} · {count}
                            </Badge>
                          ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
