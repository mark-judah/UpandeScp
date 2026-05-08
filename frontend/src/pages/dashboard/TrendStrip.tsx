import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
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
import { EmptyHint } from "./EmptyHint";

const PALETTE = [
  "var(--sd-data-cyan)",
  "var(--sd-data-pink)",
  "var(--sd-data-purple)",
  "var(--sd-data-amber)",
  "var(--sd-data-green)",
  "var(--sd-data-indigo)",
  "var(--sd-data-red)",
];

/**
 * Wide trend strip used at the top of Pests / Diseases / Traps tabs.
 * Renders one line per top-N item with linear (sharp) segments, matching
 * the JS dashboard's "Pest Trends / Disease Trends / Trap Trends" header
 * charts.
 */
export function TrendStrip({
  title,
  description,
  rows,
  keys,
  unit = "",
}: {
  title: string;
  description: string;
  rows: Array<Record<string, string | number>>;
  keys: string[];
  unit?: string;
}) {
  if (!rows.length || !keys.length) {
    return (
      <Card className="p-4">
        <CardHeader className="p-0 pb-2">
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <EmptyHint title="No trend data" hint="Nothing recorded in this range." />
        </CardContent>
      </Card>
    );
  }
  const config: ChartConfig = keys.reduce(
    (a, k, i) => ({ ...a, [k]: { label: k, color: PALETTE[i % PALETTE.length] } }),
    {},
  );
  return (
    <Card className="p-4">
      <CardHeader className="p-0 pb-2">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ChartContainer config={config} className="h-56">
          <LineChart data={rows} margin={{ left: 4, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              minTickGap={30}
              tickFormatter={(v: string) => v.slice(5)}
            />
            <YAxis tickLine={false} axisLine={false} width={32} />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  indicator="line"
                  formatter={(v) => `${v}${unit}`}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            {keys.map((k, i) => (
              <Line
                key={k}
                type="linear"
                dataKey={k}
                stroke={PALETTE[i % PALETTE.length]}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
