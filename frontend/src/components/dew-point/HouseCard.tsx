import { useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { chartPoints, riskBands, slotMs, type DewHouse } from "@/lib/dew-point-api";
import { houseLabel } from "@/lib/places";
import { cn } from "@/lib/utils";

const CONFIG: ChartConfig = {
  temp: { label: "Temperature °C", color: "var(--sd-data-amber)" },
  dew: { label: "Dew point °C", color: "var(--chart-1)" },
  spread: { label: "Spread °C", color: "var(--chart-3)" },
};

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");
export const fmtTick = (ms: number) => {
  const d = new Date(ms);
  return `${WEEKDAY[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtNum = (v: number | null | undefined, nd = 1) => (v === null || v === undefined ? "—" : v.toFixed(nd));

export function RiskBadge({ risk }: { risk: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
        risk
          ? "bg-[var(--sd-data-red)]/15 text-[var(--sd-data-red)]"
          : "bg-[var(--sd-bg-soft)] text-[var(--sd-quiet)]",
      )}
    >
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", risk ? "bg-[var(--sd-data-red)]" : "bg-[var(--sd-data-green)]")} />
      {risk ? "Risk" : "OK"}
    </span>
  );
}

/** One greenhouse: header with its state, the temperature / dew point chart with
 *  the at-risk spells shaded, the spread chart against the limit, and the table. */
export function HouseCard({ house, limit, slotMinutes }: { house: DewHouse; limit: number; slotMinutes: number }) {
  const points = useMemo(() => chartPoints(house.slots), [house.slots]);
  const bands = useMemo(() => riskBands(house.slots, slotMinutes), [house.slots, slotMinutes]);
  const rows = useMemo(() => [...house.slots].reverse(), [house.slots]);
  const s = house.summary;
  const domain: [number, number] | ["dataMin", "dataMax"] = points.length
    ? [points[0].t, points[points.length - 1].t + slotMinutes * 60_000]
    : ["dataMin", "dataMax"];
  const xAxis = (
    <XAxis
      dataKey="t"
      type="number"
      scale="time"
      domain={domain}
      tickFormatter={fmtTick}
      tickLine={false}
      axisLine={false}
      minTickGap={48}
    />
  );
  const tip = (
    <ChartTooltip content={<ChartTooltipContent labelFormatter={(l) => fmtTick(Number(l))} />} />
  );
  return (
    <section data-testid="dew-house" className="rounded-xl bg-card p-4 shadow-[var(--sd-shadow-1)]">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{houseLabel(house.greenhouse)}</h3>
          <div className="text-xs text-[var(--sd-quiet)]">
            {house.farm ? `${house.farm} · ` : ""}
            {house.sensors_reporting} of {house.sensors} sensor{house.sensors === 1 ? "" : "s"} reporting
            {s.latest_reading ? ` · last reading ${fmtTick(slotMs(s.latest_reading))}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs tabular-nums text-[var(--sd-quiet)]">
          <span>Lowest spread {fmtNum(s.min_spread)} °C</span>
          <span>{fmtNum(s.hours_at_risk)} h at risk</span>
          <RiskBadge risk={s.at_risk_now} />
        </div>
      </div>

      {house.slots.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">
          No readings from this house's sensors in this range.
        </div>
      ) : (
        <>
          <ChartContainer config={CONFIG} className="mt-3 aspect-auto h-[210px]">
            <ComposedChart data={points} margin={{ left: 0, right: 8 }}>
              <CartesianGrid vertical={false} />
              {xAxis}
              <YAxis width={32} tickLine={false} axisLine={false} unit="°" domain={["auto", "auto"]} />
              {bands.map((b) => (
                <ReferenceArea key={b.x1} x1={b.x1} x2={b.x2} fill="var(--sd-data-red)" fillOpacity={0.12} stroke="none" ifOverflow="hidden" />
              ))}
              {tip}
              <Line dataKey="temp" type="monotone" stroke="var(--color-temp)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
              <Line dataKey="dew" type="monotone" stroke="var(--color-dew)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
            </ComposedChart>
          </ChartContainer>
          <ChartContainer config={CONFIG} className="aspect-auto h-[110px]">
            <ComposedChart data={points} margin={{ left: 0, right: 8 }}>
              <CartesianGrid vertical={false} />
              {xAxis}
              <YAxis width={32} tickLine={false} axisLine={false} unit="°" domain={[0, "auto"]} />
              {bands.map((b) => (
                <ReferenceArea key={b.x1} x1={b.x1} x2={b.x2} fill="var(--sd-data-red)" fillOpacity={0.12} stroke="none" ifOverflow="hidden" />
              ))}
              <ReferenceLine y={limit} stroke="var(--sd-data-red)" strokeDasharray="4 3" label={{ value: `limit ${limit}°`, position: "insideTopRight", fontSize: 10, fill: "var(--sd-quiet)" }} />
              {tip}
              <Line dataKey="spread" type="monotone" stroke="var(--color-spread)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
            </ComposedChart>
          </ChartContainer>

          <div className="mt-3 max-h-72 overflow-auto rounded-lg border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead className="text-right">Temp °C</TableHead>
                  <TableHead className="text-right">RH %</TableHead>
                  <TableHead className="text-right">Dew point °C</TableHead>
                  <TableHead className="text-right">Spread °C</TableHead>
                  <TableHead>Risk</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.ts}>
                    <TableCell className="whitespace-nowrap tabular-nums">{fmtTick(slotMs(r.ts))}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(r.temp)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(r.rh, 0)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(r.dew_point)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(r.spread)}</TableCell>
                    <TableCell><RiskBadge risk={r.risk} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </section>
  );
}
