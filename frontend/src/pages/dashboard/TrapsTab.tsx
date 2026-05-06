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

import { EmptyHint } from "./EmptyHint"
import { Kpi } from "./Kpi"
import type { AggregatedScouting } from "./aggregate"
import { focusKey } from "@/lib/scouting-api"

interface Props {
  data: AggregatedScouting
  loading: boolean
}

export function TrapsTab({ data, loading }: Props) {
  const traps = data.traps
  const totalCatches = data.totalTrapObservations
  const fcmCount = useMemo(
    () => traps.filter((t) => focusKey(t.pest)).reduce((s, t) => s + t.total, 0),
    [traps],
  )
  const avgPerTrap =
    traps.length > 0 ? Math.round(totalCatches / traps.length) : 0

  // Top traps
  const topTraps = useMemo(
    () =>
      traps
        .slice(0, 12)
        .map((t) => ({ trap: `${t.trap} · ${t.pest}`, total: t.total })),
    [traps],
  )
  const topTrapsConfig = {
    total: { label: "Catches", color: "var(--chart-2)" },
  } satisfies ChartConfig

  // Pest breakdown across traps
  const pestBreakdown = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of traps) map.set(t.pest, (map.get(t.pest) || 0) + t.total)
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
  }, [traps])
  const PEST_COLORS = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)",
  ]
  const pestConfig = {
    count: { label: "Catches" },
  } satisfies ChartConfig

  const ghTraps = useMemo(
    () =>
      data.greenhouses
        .map((g) => ({ greenhouse: g.name, traps: g.traps }))
        .filter((g) => g.traps > 0)
        .sort((a, b) => b.traps - a.traps)
        .slice(0, 10),
    [data.greenhouses],
  )
  const ghConfig = {
    traps: { label: "Catches", color: "var(--chart-2)" },
  } satisfies ChartConfig

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Active traps" value={traps.length.toString()} accent="chart-2" />
        <Kpi
          label="Total catches"
          value={totalCatches.toString()}
          accent="chart-1"
          hint={`avg ${avgPerTrap} / trap`}
        />
        <Kpi
          label="FCM-class catches"
          value={fcmCount.toString()}
          accent="chart-5"
          hint="focus pests this period"
        />
        <Kpi
          label="Alerts"
          value={data.totalAlerts.toString()}
          accent="severity-high"
          hint="trap > 10 in a session"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Top traps</CardTitle>
          <CardDescription>Top 12 trap × pest pairs by total catches</CardDescription>
        </CardHeader>
        <CardContent>
          {topTraps.length === 0 ? (
            <EmptyHint loading={loading}>No trap data.</EmptyHint>
          ) : (
            <ChartContainer config={topTrapsConfig} className="aspect-[16/6] w-full">
              <BarChart data={topTraps} margin={{ left: 8, right: 8 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="trap"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  interval={0}
                  angle={-25}
                  height={80}
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

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pest breakdown in traps</CardTitle>
            <CardDescription>By pest captured</CardDescription>
          </CardHeader>
          <CardContent>
            {pestBreakdown.length === 0 ? (
              <EmptyHint loading={loading}>No pest breakdown.</EmptyHint>
            ) : (
              <ChartContainer
                config={pestConfig}
                className="mx-auto aspect-square max-h-[280px]"
              >
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                  <Pie
                    data={pestBreakdown}
                    dataKey="count"
                    nameKey="name"
                    innerRadius={50}
                    strokeWidth={3}
                  >
                    {pestBreakdown.map((_, i) => (
                      <Cell key={i} fill={PEST_COLORS[i % PEST_COLORS.length]} />
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
            <CardTitle className="text-base">Trap activity by greenhouse</CardTitle>
            <CardDescription>Top 10 greenhouses by trap entries</CardDescription>
          </CardHeader>
          <CardContent>
            {ghTraps.length === 0 ? (
              <EmptyHint loading={loading}>No greenhouse trap data.</EmptyHint>
            ) : (
              <ChartContainer config={ghConfig} className="aspect-[16/9] w-full">
                <BarChart data={ghTraps} layout="vertical" margin={{ left: 8 }}>
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
                  <Bar dataKey="traps" fill="var(--color-traps)" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Trap details</CardTitle>
          <CardDescription>Trap × pest with total catches and last location</CardDescription>
        </CardHeader>
        <CardContent>
          {traps.length === 0 ? (
            <EmptyHint loading={loading}>No trap details.</EmptyHint>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Trap</TableHead>
                  <TableHead>Pest</TableHead>
                  <TableHead className="text-right">Total catches</TableHead>
                  <TableHead>Location</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {traps.slice(0, 20).map((t) => (
                  <TableRow key={`${t.trap}-${t.pest}`}>
                    <TableCell className="font-medium">{t.trap}</TableCell>
                    <TableCell>{t.pest}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.total}</TableCell>
                    <TableCell className="text-muted-foreground">{t.location ?? "—"}</TableCell>
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
