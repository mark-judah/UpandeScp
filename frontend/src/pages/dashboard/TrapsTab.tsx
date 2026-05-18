import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Kpi, KpiGrid } from "./Kpi";
import { EmptyHint } from "./EmptyHint";
import { TrendStrip } from "./TrendStrip";
import type { TrapsPayload } from "./traps-types";

const PALETTE = [
  "var(--sd-data-purple)",
  "var(--sd-data-cyan)",
  "var(--sd-data-pink)",
  "var(--sd-data-amber)",
  "var(--sd-data-green)",
  "var(--sd-data-indigo)",
];

export function TrapsTab({ data }: { data: TrapsPayload | null }) {
  const ranking = data?.ranking ?? [];
  const breakdown = data?.pestBreakdown ?? [];
  const trend = data?.trendSeries ?? { rows: [], keys: [] };
  const k = data?.kpis ?? { trapZones: 0, activeTraps: 0, fcmCount: 0, totalCatches: 0 };

  const barConfig: ChartConfig = {
    total: { label: "Catches", color: "var(--sd-data-purple)" },
  };
  const pieConfig: ChartConfig = breakdown.reduce<ChartConfig>(
    (a, b, i) => ({
      ...a,
      [b.name]: { label: b.name, color: PALETTE[i % PALETTE.length] },
    }),
    {},
  );

  return (
    <div className="flex flex-col gap-4">
      <KpiGrid cols={4}>
        <Kpi label="Trap Zones" value={k.trapZones} hint="greenhouses with traps" />
        <Kpi label="Active Traps" value={k.activeTraps} hint="distinct traps" />
        <Kpi label="FCM Count" value={k.fcmCount} hint="false codling moth catches" />
        <Kpi label="Total Catches" value={k.totalCatches} hint="across range" />
      </KpiGrid>

      <TrendStrip
        title="Trap Trends"
        description="Top pests by daily catches"
        rows={trend.rows}
        keys={trend.keys}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Trap Performance</CardTitle>
            <CardDescription>Top traps by catches</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {ranking.length ? (
              <ChartContainer config={barConfig} className="h-72">
                <BarChart
                  data={ranking.slice(0, 10)}
                  layout="vertical"
                  margin={{ left: 12, right: 12 }}
                >
                  <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                  <XAxis type="number" tickLine={false} axisLine={false} />
                  <YAxis
                    type="category"
                    dataKey="trap"
                    tickLine={false}
                    axisLine={false}
                    width={120}
                  />
                  <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                  <Bar dataKey="total" fill="var(--color-total)" radius={[4, 4, 4, 4]} />
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyHint />
            )}
          </CardContent>
        </Card>

        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Pest Breakdown</CardTitle>
            <CardDescription>Catches by pest</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {breakdown.length ? (
              <ChartContainer config={pieConfig} className="h-72">
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                  <Pie
                    data={breakdown}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="55%"
                    outerRadius="90%"
                    stroke="var(--sd-card)"
                    strokeWidth={2}
                  >
                    {breakdown.map((b, i) => (
                      <Cell key={b.name} fill={PALETTE[i % PALETTE.length]} />
                    ))}
                  </Pie>
                  <ChartLegend content={<ChartLegendContent />} />
                </PieChart>
              </ChartContainer>
            ) : (
              <EmptyHint />
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="p-4">
        <CardHeader className="p-0 pb-2">
          <CardTitle>Trap Details</CardTitle>
          <CardDescription>{ranking.length} trap × pest pairs</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {ranking.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Trap</TableHead>
                  <TableHead>Pest</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Avg / visit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ranking.slice(0, 30).map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="font-medium">{r.trap}</TableCell>
                    <TableCell className="text-muted-foreground">{r.pest}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.total}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {r.avg}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyHint />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
