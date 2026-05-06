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

export function DiseasesTab({ data, loading }: Props) {
  const totalEntries = data.totalEntries
  const totalDiseaseObs = data.totalDiseaseObservations
  const activeDiseases = data.diseases.length
  const severeCount = data.diseases.reduce((s, d) => s + d.severity.high, 0)
  const top = data.diseases[0]

  const topDiseasesBar = useMemo(
    () => data.diseases.slice(0, 10).map((d) => ({ name: d.name, total: d.total })),
    [data.diseases],
  )
  const topDiseasesConfig = {
    total: { label: "Observations", color: "var(--chart-3)" },
  } satisfies ChartConfig

  const stageData = useMemo(() => {
    const totals: Record<string, number> = {}
    for (const d of data.diseases) {
      for (const [stage, n] of Object.entries(d.stages)) {
        totals[stage] = (totals[stage] || 0) + n
      }
    }
    return Object.entries(totals)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
  }, [data.diseases])
  const STAGE_COLORS = [
    "var(--chart-3)",
    "var(--chart-1)",
    "var(--chart-5)",
    "var(--chart-2)",
    "var(--chart-4)",
  ]
  const stageConfig = {
    count: { label: "Observations" },
  } satisfies ChartConfig

  const severityData = useMemo(() => {
    const sums = data.diseases.reduce(
      (acc, d) => {
        acc.low += d.severity.low
        acc.moderate += d.severity.moderate
        acc.high += d.severity.high
        return acc
      },
      { low: 0, moderate: 0, high: 0 },
    )
    return [
      { level: "Low", count: sums.low, fill: "var(--severity-low)" },
      { level: "Moderate", count: sums.moderate, fill: "var(--severity-mod)" },
      { level: "High", count: sums.high, fill: "var(--severity-high)" },
    ].filter((d) => d.count > 0)
  }, [data.diseases])
  const severityConfig = {
    count: { label: "Observations" },
  } satisfies ChartConfig

  const ghPressure = useMemo(
    () =>
      data.greenhouses
        .map((g) => ({ greenhouse: g.name, diseases: g.diseases }))
        .filter((g) => g.diseases > 0)
        .sort((a, b) => b.diseases - a.diseases)
        .slice(0, 10),
    [data.greenhouses],
  )
  const ghConfig = {
    diseases: { label: "Disease obs", color: "var(--chart-3)" },
  } satisfies ChartConfig

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Total entries" value={totalEntries.toString()} accent="chart-2" />
        <Kpi
          label="Disease observations"
          value={totalDiseaseObs.toString()}
          accent="chart-3"
          hint={`${activeDiseases} unique`}
        />
        <Kpi
          label="Severe cases"
          value={severeCount.toString()}
          accent="severity-high"
          hint="high severity"
        />
        <Kpi
          label="Top disease"
          value={top ? top.name : "—"}
          hint={top ? `${top.total} cases` : "no data"}
          accent="chart-1"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Top diseases</CardTitle>
          <CardDescription>Top 10 by observation count</CardDescription>
        </CardHeader>
        <CardContent>
          {topDiseasesBar.length === 0 ? (
            <EmptyHint loading={loading}>No disease observations.</EmptyHint>
          ) : (
            <ChartContainer config={topDiseasesConfig} className="aspect-[16/6] w-full">
              <BarChart data={topDiseasesBar} margin={{ left: 8, right: 8 }}>
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
            <CardTitle className="text-base">Stage distribution</CardTitle>
            <CardDescription>Across all diseases</CardDescription>
          </CardHeader>
          <CardContent>
            {stageData.length === 0 ? (
              <EmptyHint loading={loading}>No stage data.</EmptyHint>
            ) : (
              <ChartContainer
                config={stageConfig}
                className="mx-auto aspect-square max-h-[260px]"
              >
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                  <Pie
                    data={stageData}
                    dataKey="count"
                    nameKey="name"
                    innerRadius={50}
                    strokeWidth={3}
                  >
                    {stageData.map((_, i) => (
                      <Cell key={i} fill={STAGE_COLORS[i % STAGE_COLORS.length]} />
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
            <CardTitle className="text-base">Severity levels</CardTitle>
            <CardDescription>Inferred from stage keywords</CardDescription>
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
            <CardTitle className="text-base">Disease pressure by greenhouse</CardTitle>
            <CardDescription>Top 10 greenhouses</CardDescription>
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
                  <Bar dataKey="diseases" fill="var(--color-diseases)" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Disease incidents</CardTitle>
          <CardDescription>Stage breakdown for the top 10 diseases</CardDescription>
        </CardHeader>
        <CardContent>
          {data.diseases.length === 0 ? (
            <EmptyHint loading={loading}>No disease incident data.</EmptyHint>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Disease</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Stages</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.diseases.slice(0, 10).map((d) => (
                  <TableRow key={d.name}>
                    <TableCell className="font-medium">{d.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{d.total}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(d.stages)
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
