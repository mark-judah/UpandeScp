/**
 * Compare chemical levels across CSUs — "which chemical is where".
 *
 * Pick the CSUs to check and up to {MAX_SELECT} chemicals, then compare their
 * quantities side by side (grouped bar chart + a compact table). Reuses the
 * page's already-fetched ``chemical_stock_overview`` payload (passed in as a
 * prop) so it adds no extra network call and refreshes with the page.
 *
 * CSU warehouses are detected the same way the backend does (a whole-word
 * "csu" in the warehouse name), so Chemical Stores / Pasteurization Unit /
 * Work In Progress are excluded.
 */
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, XAxis, YAxis } from "recharts";
import { Warehouse, Search, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ChemicalOverview } from "@/lib/store-keeper-api";
import { cn } from "@/lib/utils";

const CSU_RE = /\bcsu\b/i;
const MAX_SELECT = 5;
const PALETTE = [
  "var(--sd-data-cyan, #06b6d4)",
  "var(--sd-data-amber, #f59e0b)",
  "var(--sd-data-violet, #8b5cf6)",
  "var(--sd-data-green, #10b981)",
  "var(--sd-data-red, #ef4444)",
];

function fmt(n: number): string {
  if (!n) return "0";
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** "Chepsito CSU Phase 1 - KR" -> "Chepsito CSU 1" (compact label). */
function csuLabel(name: string): string {
  return name
    .replace(/\s+-\s+[A-Za-z]{1,4}$/, "")
    .replace(/CSU\s+Phase\s+/i, "CSU ")
    .trim();
}

export function CsuLevels({
  data,
  loading,
}: {
  data: ChemicalOverview | null;
  loading?: boolean;
}) {
  const [selectedCsus, setSelectedCsus] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]); // chemical codes
  const [seeded, setSeeded] = useState(false);
  const [pickQuery, setPickQuery] = useState("");

  // Full CSU roster (all enabled CSUs, even empty ones) so the selector shows
  // every CSU; falls back to stock-bearing warehouses on an older backend.
  const csus = useMemo(() => {
    const roster =
      data?.csus && data.csus.length
        ? data.csus.map((c) => c.warehouse)
        : (data?.warehouses || []).map((w) => w.warehouse);
    return roster
      .filter((w) => CSU_RE.test(w))
      .sort((a, b) => a.localeCompare(b));
  }, [data]);

  // CSUs that actually hold chemical stock right now — the rest are disabled.
  const stockCsus = useMemo(() => {
    const s = new Set<string>();
    for (const c of data?.matrix || []) {
      if (c.qty > 0 && CSU_RE.test(c.warehouse)) s.add(c.warehouse);
    }
    return s;
  }, [data]);

  // qty[item][warehouse], restricted to CSU warehouses.
  const byItem = useMemo(() => {
    const csuSet = new Set(csus);
    const map: Record<string, Record<string, number>> = {};
    for (const c of data?.matrix || []) {
      if (!csuSet.has(c.warehouse)) continue;
      (map[c.item_code] ||= {})[c.warehouse] = c.qty;
    }
    return map;
  }, [data, csus]);

  const itemName = useMemo(() => {
    const m = new Map<string, string>();
    (data?.items || []).forEach((i) => m.set(i.item_code, i.item_name));
    return m;
  }, [data]);

  // Chemicals present in any CSU, sorted by total CSU qty desc (picker list).
  const chemicals = useMemo(() => {
    const out = Object.entries(byItem).map(([code, perWh]) => ({
      item_code: code,
      item_name: itemName.get(code) || code,
      total: Object.values(perWh).reduce((s, q) => s + q, 0),
    }));
    out.sort((a, b) => b.total - a.total);
    return out;
  }, [byItem, itemName]);

  // Seed once: all CSUs that have stock are checked, the top chemical selected.
  useEffect(() => {
    if (seeded || !csus.length) return;
    setSelectedCsus(csus.filter((w) => stockCsus.has(w)));
    if (chemicals.length) setSelected([chemicals[0].item_code]);
    setSeeded(true);
  }, [csus, stockCsus, chemicals, seeded]);

  // Selected CSUs in display order; one bar group per CSU.
  const shownCsus = useMemo(
    () => csus.filter((w) => selectedCsus.includes(w)),
    [csus, selectedCsus],
  );

  const chartData = useMemo(
    () =>
      shownCsus.map((wh) => {
        const row: Record<string, number | string> = { csu: csuLabel(wh) };
        selected.forEach((code) => {
          row[code] = Math.round((byItem[code]?.[wh] || 0) * 100) / 100;
        });
        return row;
      }),
    [shownCsus, selected, byItem],
  );

  const chartConfig: ChartConfig = useMemo(() => {
    const cfg: ChartConfig = {};
    selected.forEach((code, i) => {
      cfg[code] = {
        label: itemName.get(code) || code,
        color: PALETTE[i % PALETTE.length],
      };
    });
    return cfg;
  }, [selected, itemName]);

  const pickList = useMemo(() => {
    const q = pickQuery.trim().toLowerCase();
    if (!q) return chemicals.slice(0, 60);
    return chemicals
      .filter(
        (i) =>
          i.item_name.toLowerCase().includes(q) ||
          i.item_code.toLowerCase().includes(q),
      )
      .slice(0, 60);
  }, [chemicals, pickQuery]);

  const toggleChem = (code: string) =>
    setSelected((prev) => {
      if (prev.includes(code)) return prev.filter((c) => c !== code);
      if (prev.length >= MAX_SELECT) return prev;
      return [...prev, code];
    });

  const toggleCsu = (wh: string) => {
    if (!stockCsus.has(wh)) return; // empty CSU — disabled, not selectable
    setSelectedCsus((prev) =>
      prev.includes(wh) ? prev.filter((c) => c !== wh) : [...prev, wh],
    );
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Warehouse className="h-4 w-4" />
          Compare chemical levels across CSUs
        </CardTitle>
        <CardDescription>
          Pick the CSUs to check and up to {MAX_SELECT} chemicals to compare —
          which chemical is where, and how much. {stockCsus.size} of {csus.length}{" "}
          CSU{csus.length === 1 ? "" : "s"} hold stock; empty ones are disabled.
          {selected.length >= MAX_SELECT && " Max reached — deselect one to swap."}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* CSU selector */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-semibold">
              CSUs
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[0.65rem]"
              onClick={() => setSelectedCsus(csus.filter((w) => stockCsus.has(w)))}
            >
              All
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[0.65rem]"
              onClick={() => setSelectedCsus([])}
            >
              None
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {csus.map((wh) => {
              const empty = !stockCsus.has(wh);
              const on = selectedCsus.includes(wh);
              return (
                <button
                  key={wh}
                  onClick={() => toggleCsu(wh)}
                  disabled={empty}
                  title={empty ? `${wh} — no stock` : wh}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[0.7rem] transition-colors",
                    empty
                      ? "border-dashed text-muted-foreground/40 cursor-not-allowed"
                      : on
                        ? "bg-primary/10 border-primary/40 text-foreground"
                        : "bg-transparent text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  {csuLabel(wh)}
                  {empty && <span className="ml-1 text-[0.6rem]">·empty</span>}
                </button>
              );
            })}
            {!csus.length && (
              <span className="text-xs text-muted-foreground">
                {loading ? "Loading…" : "No CSU warehouses holding stock."}
              </span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Chemical picker */}
          <div className="lg:col-span-1 flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5 min-h-7">
              {selected.map((code, i) => (
                <Badge
                  key={code}
                  className="gap-1 text-[0.65rem]"
                  style={{ backgroundColor: PALETTE[i % PALETTE.length], color: "#fff" }}
                >
                  {itemName.get(code) || code}
                  <button onClick={() => toggleChem(code)} aria-label="Remove">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              {!selected.length && (
                <span className="text-xs text-muted-foreground">
                  Pick a chemical.
                </span>
              )}
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Find a chemical…"
                className="h-8 pl-8 text-xs"
                value={pickQuery}
                onChange={(e) => setPickQuery(e.target.value)}
              />
            </div>
            <div className="rounded-md border max-h-64 overflow-auto divide-y">
              {pickList.map((it) => {
                const on = selected.includes(it.item_code);
                const disabled = !on && selected.length >= MAX_SELECT;
                return (
                  <button
                    key={it.item_code}
                    onClick={() => toggleChem(it.item_code)}
                    disabled={disabled}
                    className={cn(
                      "w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs",
                      on ? "bg-primary/5" : "hover:bg-muted/40",
                      disabled && "opacity-40 cursor-not-allowed",
                    )}
                  >
                    <span className="truncate font-medium">{it.item_name}</span>
                    <span className="tabular-nums text-muted-foreground shrink-0">
                      {fmt(it.total)}
                    </span>
                  </button>
                );
              })}
              {!pickList.length && (
                <div className="px-2.5 py-2 text-xs text-muted-foreground">
                  No chemicals match.
                </div>
              )}
            </div>
          </div>

          {/* Grouped bar chart: one group per selected CSU */}
          <div className="lg:col-span-2 min-w-0">
            {selected.length && shownCsus.length ? (
              <ChartContainer config={chartConfig} className="w-full h-80">
                <BarChart
                  data={chartData}
                  margin={{ left: 12, right: 12, top: 8, bottom: 24 }}
                >
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="csu"
                    tickLine={false}
                    axisLine={false}
                    interval={0}
                    tick={{ fontSize: 10 }}
                    angle={-20}
                    height={50}
                    textAnchor="end"
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={52}
                    tickFormatter={(v: number) => fmt(v)}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {selected.map((code, i) => (
                    <Bar
                      key={code}
                      dataKey={code}
                      name={itemName.get(code) || code}
                      fill={PALETTE[i % PALETTE.length]}
                      radius={3}
                    />
                  ))}
                </BarChart>
              </ChartContainer>
            ) : (
              <div className="flex items-center justify-center h-80 text-xs text-muted-foreground">
                {!shownCsus.length
                  ? "Select at least one CSU."
                  : "Pick a chemical to compare."}
              </div>
            )}
          </div>
        </div>

        {/* Exact numbers: selected chemicals x selected CSUs */}
        {selected.length > 0 && shownCsus.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead className="text-[0.65rem] uppercase tracking-wide text-muted-foreground border-b">
                <tr>
                  <th className="text-left px-3 py-2 sticky left-0 bg-card z-10 min-w-44">
                    Chemical
                  </th>
                  <th className="text-right px-3 py-2 whitespace-nowrap">Total</th>
                  {shownCsus.map((wh) => (
                    <th
                      key={wh}
                      className="text-right px-3 py-2 whitespace-nowrap"
                      title={wh}
                    >
                      {csuLabel(wh)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {selected.map((code) => {
                  const perWh = byItem[code] || {};
                  const total = shownCsus.reduce(
                    (s, wh) => s + (perWh[wh] || 0),
                    0,
                  );
                  return (
                    <tr
                      key={code}
                      className="border-b last:border-0 hover:bg-muted/30"
                    >
                      <td className="px-3 py-1.5 sticky left-0 bg-card z-10 font-medium">
                        {itemName.get(code) || code}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-semibold">
                        {fmt(total)}
                      </td>
                      {shownCsus.map((wh) => {
                        const qty = perWh[wh] || 0;
                        return (
                          <td
                            key={wh}
                            className={cn(
                              "px-3 py-1.5 text-right tabular-nums",
                              qty > 0 ? "font-medium" : "text-muted-foreground/40",
                            )}
                          >
                            {qty > 0 ? fmt(qty) : "·"}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
