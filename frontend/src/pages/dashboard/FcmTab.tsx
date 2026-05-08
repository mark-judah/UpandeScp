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
import { Kpi, KpiGrid } from "./Kpi";
import { EmptyHint } from "./EmptyHint";
import { trapPestBreakdown } from "./aggregate";
import type { ProcessedData } from "@/lib/scouting-types";

const FOCUS = /fcm|moth|codling|tortrix|noctuid/i;

export function FcmTab({ data }: { data: ProcessedData | null }) {
  const focusTraps = data
    ? Object.values(data.traps).filter((t) => FOCUS.test(t.pest))
    : [];
  const focusPests = data
    ? Object.values(data.pests).filter((p) => FOCUS.test(p.name))
    : [];

  const trapTotal = focusTraps.reduce((s, t) => s + t.total, 0);
  const pestTotal = focusPests.reduce(
    (s, p) => s + p.counts.reduce((a, c) => a + (c.count || 0), 0),
    0,
  );

  const zones = new Set<string>();
  focusPests.forEach((p) =>
    p.counts.forEach((c) => {
      if (c.zone) zones.add(c.zone);
    }),
  );
  const ghs = new Set<string>();
  focusTraps.forEach((t) =>
    t.counts.forEach((c) => {
      if (c.greenhouse) ghs.add(c.greenhouse);
    }),
  );

  const dailyMap: Record<string, { date: string; traps: number; scouting: number }> = {};
  focusTraps.forEach((t) =>
    t.counts.forEach((c) => {
      if (!dailyMap[c.date]) dailyMap[c.date] = { date: c.date, traps: 0, scouting: 0 };
      dailyMap[c.date].traps += c.count || 0;
    }),
  );
  focusPests.forEach((p) =>
    p.counts.forEach((c) => {
      if (!dailyMap[c.date]) dailyMap[c.date] = { date: c.date, traps: 0, scouting: 0 };
      dailyMap[c.date].scouting += c.count || 0;
    }),
  );
  const daily = Object.values(dailyMap).sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  const breakdown = trapPestBreakdown(data).filter((b) => FOCUS.test(b.name));

  const lineConfig: ChartConfig = {
    traps: { label: "Trap catches", color: "var(--sd-data-purple)" },
    scouting: { label: "Scouting counts", color: "var(--sd-data-pink)" },
  };
  const barConfig: ChartConfig = {
    value: { label: "Catches", color: "var(--sd-data-amber)" },
  };

  return (
    <div className="flex flex-col gap-4">
      <KpiGrid cols={4}>
        <Kpi label="Trap Counts" value={trapTotal} hint="focus pests · traps" />
        <Kpi label="Non-Trap Counts" value={pestTotal} hint="focus pests · scouting" />
        <Kpi label="Focus Zones" value={zones.size} hint="zones with focus pests" />
        <Kpi label="Greenhouses" value={ghs.size} hint="impacted" />
      </KpiGrid>

      <Card className="p-4">
        <CardHeader className="p-0 pb-2">
          <CardTitle>FCM &amp; Moth Trends</CardTitle>
          <CardDescription>Daily catches and scouting counts</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {daily.length ? (
            <ChartContainer config={lineConfig} className="h-64">
              <LineChart data={daily} margin={{ left: 4, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={30}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis tickLine={false} axisLine={false} width={32} />
                <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Line
                  type="monotone"
                  dataKey="traps"
                  stroke="var(--color-traps)"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="scouting"
                  stroke="var(--color-scouting)"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ChartContainer>
          ) : (
            <EmptyHint title="No focus-pest activity" />
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Trap Breakdown</CardTitle>
            <CardDescription>Focus-pest catches</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {breakdown.length ? (
              <ChartContainer config={barConfig} className="h-60">
                <BarChart data={breakdown}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="name" tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} width={32} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyHint />
            )}
          </CardContent>
        </Card>

        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Focus Pest Counts</CardTitle>
            <CardDescription>Top focus pests by scouting</CardDescription>
          </CardHeader>
          <CardContent className="p-0 flex flex-col gap-1.5">
            {focusPests.length ? (
              focusPests
                .map((p) => ({
                  name: p.name,
                  total: p.counts.reduce((s, c) => s + (c.count || 0), 0),
                }))
                .sort((a, b) => b.total - a.total)
                .slice(0, 10)
                .map((r) => (
                  <div
                    key={r.name}
                    className="flex items-center justify-between px-3 py-2 rounded-md border bg-[var(--sd-bg-soft)]"
                  >
                    <span className="text-sm font-medium">{r.name}</span>
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {r.total}
                    </span>
                  </div>
                ))
            ) : (
              <EmptyHint title="No focus pests" />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
