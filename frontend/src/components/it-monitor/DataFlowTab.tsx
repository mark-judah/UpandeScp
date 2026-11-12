import { Bar, BarChart, CartesianGrid, Legend, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { ChartSkeleton, firstLoad } from "@/components/Loading";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { queueLabel, seriesOf, topSeries, type DayPoint, type ItDataFlow } from "@/lib/it-monitor-api";
import { CHART_COLORS, Empty, SectionCard } from "./parts";

const STATUS_COLOR: Record<string, string> = {
  Synced: "var(--sd-data-green)", Held: "var(--sd-data-amber)", Partial: "var(--sd-data-cyan)", Refused: "var(--sd-data-red)",
};

function dayLabel(d: string): string {
  return d.slice(5); // MM-DD
}

function Stacked({ points, series, colors, height = 220 }: { points: DayPoint[]; series: string[]; colors?: Record<string, string>; height?: number }) {
  const cfg: ChartConfig = Object.fromEntries(
    series.map((s, i) => [s.replace(/[^a-zA-Z0-9_-]/g, "_"), { label: s, color: colors?.[s] ?? CHART_COLORS[i % CHART_COLORS.length] }]),
  );
  return (
    <ChartContainer config={cfg} className="aspect-auto w-full" style={{ height }}>
      <BarChart data={points} margin={{ left: 0, right: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickFormatter={dayLabel} tickLine={false} axisLine={false} />
        <YAxis allowDecimals={false} width={32} tickLine={false} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {series.length > 1 ? <Legend /> : null}
        {series.map((s) => (
          <Bar key={s} dataKey={s} name={s} stackId="a" fill={`var(--color-${s.replace(/[^a-zA-Z0-9_-]/g, "_")})`} />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

function Chart({ title, hint, points, first, colors, series }: { title: string; hint?: string; points: DayPoint[]; first: boolean; colors?: Record<string, string>; series?: string[] }) {
  const s = series ?? seriesOf(points);
  return (
    <SectionCard title={title} hint={hint}>
      {first ? <ChartSkeleton height={220} /> : points.length === 0 ? <Empty>No data in this period.</Empty> : <Stacked points={points} series={s} colors={colors} />}
    </SectionCard>
  );
}

export function DataFlowTab({ data, loading }: { data: ItDataFlow | null; loading: boolean }) {
  const first = firstLoad(loading, !!data);
  const scouts = data ? topSeries(data.scouting, 8) : { points: [], series: [] };
  const spray = data?.spray_sessions ?? [];
  const sprayOrder = ["Synced", "Partial", "Held", "Refused"].filter((k) => spray.some((p) => k in p));
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Chart title="Scouting entries per day" hint="One stack per scout (the busiest eight)" points={scouts.points} series={scouts.series} first={first} />
        <Chart title="Pest photos per day" points={data?.pest_photos ?? []} first={first} />
        <Chart title="CSU scans per day" points={data?.csu_scans ?? []} first={first} />
        <Chart title="Spray sessions by status" hint="Token status as the server holds it" points={spray} series={sprayOrder.length ? sprayOrder : undefined} colors={STATUS_COLOR} first={first} />
      </div>
      <SectionCard title="Waiting on phones" hint="Reported by the phones themselves, not the server">
        {first ? (
          <ChartSkeleton height={120} />
        ) : !data || data.queues.length === 0 ? (
          <Empty>No phone has reported its queues yet.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow><TableHead>Queue</TableHead><TableHead>Pending items</TableHead><TableHead>Stuck items</TableHead><TableHead>Devices</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {data.queues.map((q) => (
                <TableRow key={q.name}>
                  <TableCell>{queueLabel(q.name)}</TableCell>
                  <TableCell className="tabular-nums">{q.pending}</TableCell>
                  <TableCell className={cn("tabular-nums", q.stuck > 0 && "font-medium text-[var(--sd-data-red)]")}>{q.stuck}</TableCell>
                  <TableCell className="tabular-nums">{q.devices}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}
