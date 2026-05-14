import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { greenhouseDetail } from "./aggregate";
import type { ProcessedData } from "@/lib/scouting-types";
import { weekTickFormatter } from "@/lib/iso-week";

const SERIES = {
  pests: { label: "Pests", color: "var(--sd-data-cyan)" },
  diseases: { label: "Diseases", color: "var(--sd-data-pink)" },
  traps: { label: "Traps", color: "var(--sd-data-purple)" },
};

export function GreenhouseModal({
  data,
  greenhouse,
  open,
  onOpenChange,
  fromDate,
  toDate,
}: {
  data: ProcessedData | null;
  greenhouse: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  fromDate: string;
  toDate: string;
}) {
  const detail = greenhouseDetail(data, greenhouse || "");
  const total =
    detail.topPests.reduce((s, x) => s + x.count, 0) +
    detail.topDiseases.reduce((s, x) => s + x.count, 0) +
    detail.traps.reduce((s, x) => s + x.total, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{greenhouse || "Greenhouse"}</DialogTitle>
          <DialogDescription>
            {fromDate} → {toDate} · {detail.scouts} scout
            {detail.scouts !== 1 ? "s" : ""} · {total} observation
            {total !== 1 ? "s" : ""}
            {detail.alerts > 0 && (
              <Badge variant="destructive" className="ml-2 text-[0.65rem]">
                {detail.alerts} alert{detail.alerts !== 1 ? "s" : ""}
              </Badge>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Card className="p-3">
            <CardHeader className="p-0 pb-1.5">
              <CardTitle className="text-[0.78rem] uppercase tracking-wide text-muted-foreground">
                Top Pests
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 flex flex-col gap-1">
              {detail.topPests.length ? (
                detail.topPests.map((p) => (
                  <div
                    key={p.name}
                    className="flex justify-between text-xs px-2 py-1 rounded bg-[var(--sd-bg-soft)]"
                  >
                    <span className="truncate">{p.name}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {p.count}
                    </span>
                  </div>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">None</span>
              )}
            </CardContent>
          </Card>

          <Card className="p-3">
            <CardHeader className="p-0 pb-1.5">
              <CardTitle className="text-[0.78rem] uppercase tracking-wide text-muted-foreground">
                Top Diseases
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 flex flex-col gap-1">
              {detail.topDiseases.length ? (
                detail.topDiseases.map((d) => (
                  <div
                    key={d.name}
                    className="flex justify-between text-xs px-2 py-1 rounded bg-[var(--sd-bg-soft)]"
                  >
                    <span className="truncate">{d.name}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {d.count}
                    </span>
                  </div>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">None</span>
              )}
            </CardContent>
          </Card>

          <Card className="p-3">
            <CardHeader className="p-0 pb-1.5">
              <CardTitle className="text-[0.78rem] uppercase tracking-wide text-muted-foreground">
                Trap Catches
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 flex flex-col gap-1">
              {detail.traps.length ? (
                detail.traps.map((t) => (
                  <div
                    key={t.pest}
                    className="flex justify-between text-xs px-2 py-1 rounded bg-[var(--sd-bg-soft)]"
                  >
                    <span className="truncate">{t.pest}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {t.total}
                    </span>
                  </div>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">None</span>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Daily Trend</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {detail.daily.length ? (
              <ChartContainer config={SERIES} className="h-48">
                <LineChart
                  data={detail.daily}
                  margin={{ left: 4, right: 8, top: 8 }}
                >
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
                  <ChartLegend content={<ChartLegendContent />} />
                  <Line
                    type="linear"
                    dataKey="pests"
                    stroke="var(--sd-data-cyan)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                  <Line
                    type="linear"
                    dataKey="diseases"
                    stroke="var(--sd-data-pink)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                  <Line
                    type="linear"
                    dataKey="traps"
                    stroke="var(--sd-data-purple)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ChartContainer>
            ) : (
              <span className="text-xs text-muted-foreground">
                No daily data in range
              </span>
            )}
          </CardContent>
        </Card>
      </DialogContent>
    </Dialog>
  );
}
