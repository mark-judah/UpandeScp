/**
 * Compare chemical levels across farms' chemical-store warehouses.
 *
 * Two views off one ``chemical_store_levels`` fetch:
 *   1. A grouped bar chart — pick up to 5 chemicals, compare their levels
 *      per farm (stores within a farm are summed).
 *   2. A level table — every chemical on rows, every chemical store on
 *      columns, the quantity in each cell.
 */
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, XAxis, YAxis } from "recharts";
import { BarChart3, Search, X, Loader2 } from "lucide-react";
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
import {
  fetchChemicalStoreLevels,
  type ChemicalStoreLevels,
} from "@/lib/store-keeper-api";
import { cn } from "@/lib/utils";

const MAX_SELECT = 5;
// Distinct, legible series colours (max 5 chemicals at once).
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

export function ChemicalStoreComparison() {
  const [data, setData] = useState<ChemicalStoreLevels | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [pickQuery, setPickQuery] = useState("");
  const [tableQuery, setTableQuery] = useState("");

  useEffect(() => {
    setLoading(true);
    fetchChemicalStoreLevels()
      .then((d) => {
        setData(d);
        // Seed with the top chemical so the chart isn't empty on first paint.
        setSelected(d.items.slice(0, 1).map((i) => i.item_code));
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  const itemName = useMemo(() => {
    const m = new Map<string, string>();
    (data?.items || []).forEach((i) => m.set(i.item_code, i.item_name));
    return m;
  }, [data]);

  // qty[item][warehouse] — used by both the chart (x-axis = store) and table.
  const byWarehouse = useMemo(() => {
    const map: Record<string, Record<string, number>> = {};
    for (const c of data?.matrix || []) {
      (map[c.item_code] ||= {})[c.warehouse] = c.qty;
    }
    return map;
  }, [data]);

  // One bar group per chemical store; series = each selected chemical.
  const chartData = useMemo(
    () =>
      (data?.stores || []).map((s) => {
        const row: Record<string, number | string> = { store: s.label };
        selected.forEach((code) => {
          row[code] = Math.round((byWarehouse[code]?.[s.warehouse] || 0) * 100) / 100;
        });
        return row;
      }),
    [data, selected, byWarehouse],
  );

  const chartConfig: ChartConfig = useMemo(() => {
    const cfg: ChartConfig = {};
    selected.forEach((code, i) => {
      cfg[code] = { label: itemName.get(code) || code, color: PALETTE[i % PALETTE.length] };
    });
    return cfg;
  }, [selected, itemName]);

  const pickList = useMemo(() => {
    const q = pickQuery.trim().toLowerCase();
    const items = data?.items || [];
    if (!q) return items.slice(0, 60);
    return items
      .filter(
        (i) =>
          i.item_name.toLowerCase().includes(q) ||
          i.item_code.toLowerCase().includes(q),
      )
      .slice(0, 60);
  }, [data, pickQuery]);

  const tableRows = useMemo(() => {
    const q = tableQuery.trim().toLowerCase();
    const items = data?.items || [];
    if (!q) return items;
    return items.filter(
      (i) =>
        i.item_name.toLowerCase().includes(q) ||
        i.item_code.toLowerCase().includes(q),
    );
  }, [data, tableQuery]);

  const toggle = (code: string) => {
    setSelected((prev) => {
      if (prev.includes(code)) return prev.filter((c) => c !== code);
      if (prev.length >= MAX_SELECT) return prev;
      return [...prev, code];
    });
  };

  const stores = data?.stores || [];

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading store levels…
        </CardContent>
      </Card>
    );
  }

  if (!data || !stores.length) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No chemical-store warehouses found to compare.
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4" />
            Compare chemical levels across stores
          </CardTitle>
          <CardDescription>
            Pick up to {MAX_SELECT} chemicals to compare their levels per chemical store.
            {selected.length >= MAX_SELECT && " Max reached — deselect one to swap."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Picker */}
          <div className="lg:col-span-1 flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5 min-h-7">
              {selected.map((code, i) => (
                <Badge
                  key={code}
                  className="gap-1 text-[0.65rem]"
                  style={{
                    backgroundColor: PALETTE[i % PALETTE.length],
                    color: "#fff",
                  }}
                >
                  {itemName.get(code) || code}
                  <button onClick={() => toggle(code)} aria-label="Remove">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              {!selected.length && (
                <span className="text-xs text-muted-foreground">
                  Nothing selected.
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
                    onClick={() => toggle(it.item_code)}
                    disabled={disabled}
                    className={cn(
                      "w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs",
                      on ? "bg-primary/5" : "hover:bg-muted/40",
                      disabled && "opacity-40 cursor-not-allowed",
                    )}
                  >
                    <span className="truncate">
                      <span className="font-medium">{it.item_name}</span>
                    </span>
                    <span className="tabular-nums text-muted-foreground shrink-0">
                      {fmt(it.total)} {it.uom}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Grouped bar chart */}
          <div className="lg:col-span-2 min-w-0">
            {selected.length ? (
              <ChartContainer config={chartConfig} className="w-full h-80">
                <BarChart
                  data={chartData}
                  margin={{ left: 12, right: 12, top: 8, bottom: 24 }}
                >
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="store"
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
                Pick a chemical to compare.
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Level table — chemicals × chemical stores */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Levels by chemical store</CardTitle>
          <CardDescription>
            Every chemical on rows, each store a column.
          </CardDescription>
          <div className="relative max-w-xs pt-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Filter chemicals…"
              className="h-8 pl-8 text-xs"
              value={tableQuery}
              onChange={(e) => setTableQuery(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead className="text-[0.65rem] uppercase tracking-wide text-muted-foreground border-b">
                <tr>
                  <th className="text-left px-3 py-2 sticky left-0 bg-card z-10 min-w-44">
                    Chemical
                  </th>
                  {stores.map((s) => (
                    <th key={s.warehouse} className="text-right px-3 py-2 whitespace-nowrap">
                      {s.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableRows.map((it) => (
                  <tr key={it.item_code} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-1.5 sticky left-0 bg-card z-10">
                      <div className="font-medium">{it.item_name}</div>
                      <div className="text-[0.6rem] text-muted-foreground">
                        {it.uom}
                      </div>
                    </td>
                    {stores.map((s) => {
                      const qty = byWarehouse[it.item_code]?.[s.warehouse] || 0;
                      return (
                        <td
                          key={s.warehouse}
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
                ))}
                {!tableRows.length && (
                  <tr>
                    <td
                      colSpan={stores.length + 1}
                      className="px-3 py-6 text-center text-muted-foreground"
                    >
                      No chemicals match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
