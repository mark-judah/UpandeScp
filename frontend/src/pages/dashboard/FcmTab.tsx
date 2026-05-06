import { useMemo } from "react"
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
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
import {
  focusKey,
  focusLabel,
  FOCUS_PESTS,
  type ScoutingPayload,
} from "@/lib/scouting-api"

interface Props {
  data: AggregatedScouting
  payload: ScoutingPayload | null
  loading: boolean
}

const FOCUS_COLORS: Record<string, string> = {
  fcm: "oklch(0.62 0.22 18)", // red
  helicoverpa: "oklch(0.66 0.20 35)", // orange
  duponchella: "oklch(0.60 0.10 270)", // muted purple-grey
  spodoptera: "oklch(0.55 0.20 250)", // indigo
  unidentified_moth: "oklch(0.62 0.15 200)", // teal
}

export function FcmTab({ data, payload, loading }: Props) {
  const trapTotals = useMemo(() => {
    const totals: Record<string, number> = {}
    for (const t of data.traps) {
      const k = focusKey(t.pest)
      if (k) totals[k] = (totals[k] || 0) + t.total
    }
    return totals
  }, [data.traps])

  const pestTotals = useMemo(() => {
    const totals: Record<string, number> = {}
    for (const p of data.pests) {
      const k = focusKey(p.name)
      if (k) totals[k] = (totals[k] || 0) + p.total
    }
    return totals
  }, [data.pests])

  const trapSum = Object.values(trapTotals).reduce((a, b) => a + b, 0)
  const pestSum = Object.values(pestTotals).reduce((a, b) => a + b, 0)

  // Entries impacted = entries with at least one focus pest in trap or pest children
  const impacted = useMemo(() => {
    const out: { entry: string; greenhouse: string; date: string; focus: string[] }[] = []
    const ghs = new Set<string>()
    for (const e of payload?.entries ?? []) {
      const focus: string[] = []
      for (const t of e.traps ?? []) {
        const k = focusKey(t.pest ?? "")
        if (k) focus.push(focusLabel(k))
      }
      for (const p of e.pests ?? []) {
        const k = focusKey(p.pest)
        if (k) focus.push(focusLabel(k))
      }
      if (focus.length === 0) continue
      out.push({
        entry: e.name,
        greenhouse: e.greenhouse ?? "Unknown",
        date: e.date_of_capture,
        focus: Array.from(new Set(focus)),
      })
      if (e.greenhouse) ghs.add(e.greenhouse)
    }
    return { rows: out, ghCount: ghs.size }
  }, [payload])

  const trapBars = FOCUS_PESTS
    .map((f) => ({
      key: f.key,
      label: f.label,
      total: trapTotals[f.key] ?? 0,
    }))
    .filter((d) => d.total > 0)
  const pestBars = FOCUS_PESTS
    .map((f) => ({
      key: f.key,
      label: f.label,
      total: pestTotals[f.key] ?? 0,
    }))
    .filter((d) => d.total > 0)

  const config = {
    total: { label: "Catches" },
  } satisfies ChartConfig

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi
          label="Trap counts (focus)"
          value={trapSum.toString()}
          accent="chart-3"
          hint="catches"
        />
        <Kpi
          label="Non-trap focus pest"
          value={pestSum.toString()}
          accent="chart-1"
          hint="scouting observations"
        />
        <Kpi
          label="Entries with focus"
          value={impacted.rows.length.toString()}
          accent="severity-mod"
          hint="scouting records"
        />
        <Kpi
          label="Greenhouses impacted"
          value={impacted.ghCount.toString()}
          accent="chart-5"
          hint="with observations"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Trap breakdown</CardTitle>
            <CardDescription>FCM · Helicoverpa · Duponchella · Spodoptera · Unidentified moth</CardDescription>
          </CardHeader>
          <CardContent>
            {trapBars.length === 0 ? (
              <EmptyHint loading={loading}>No focus pests in traps.</EmptyHint>
            ) : (
              <ChartContainer config={config} className="aspect-[16/8] w-full">
                <BarChart data={trapBars}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} width={32} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="total" radius={[6, 6, 0, 0]}>
                    {trapBars.map((d, i) => (
                      <Cell key={i} fill={FOCUS_COLORS[d.key] ?? "var(--chart-1)"} />
                    ))}
                  </Bar>
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Non-trap pest breakdown</CardTitle>
            <CardDescription>Scouting observations of focus pests</CardDescription>
          </CardHeader>
          <CardContent>
            {pestBars.length === 0 ? (
              <EmptyHint loading={loading}>No focus pests in pest scouting.</EmptyHint>
            ) : (
              <ChartContainer config={config} className="aspect-[16/8] w-full">
                <BarChart data={pestBars}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} width={32} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="total" radius={[6, 6, 0, 0]}>
                    {pestBars.map((d, i) => (
                      <Cell key={i} fill={FOCUS_COLORS[d.key] ?? "var(--chart-1)"} />
                    ))}
                  </Bar>
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent focus entries</CardTitle>
          <CardDescription>Top 20 scouting entries with focus pests</CardDescription>
        </CardHeader>
        <CardContent>
          {impacted.rows.length === 0 ? (
            <EmptyHint loading={loading}>No focus pest entries.</EmptyHint>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Greenhouse</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Focus pests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {impacted.rows.slice(0, 20).map((r) => (
                  <TableRow key={r.entry}>
                    <TableCell className="font-medium">{r.greenhouse}</TableCell>
                    <TableCell className="tabular-nums">{r.date}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {r.focus.map((f) => (
                          <Badge key={f} variant="secondary" className="font-normal">
                            {f}
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
