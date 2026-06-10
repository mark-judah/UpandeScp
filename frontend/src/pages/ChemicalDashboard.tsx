import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import { Beaker, RefreshCw, Search } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  fetchChemicalOverview,
  type ChemicalOverview,
} from "@/lib/store-keeper-api";
import { ChemicalStoreComparison } from "@/components/ChemicalStoreComparison";
import { cn } from "@/lib/utils";

const ALL_WAREHOUSE = "__all__";
const CHART_TOP_N = 12;

const config: ChartConfig = {
  qty: { label: "Stock", color: "var(--sd-data-cyan, #06b6d4)" },
};

function fmt(n: number): string {
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, {
    maximumFractionDigits: 0,
  });
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function ChemicalDashboard() {
  const [data, setData] = useState<ChemicalOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warehouseFilter, setWarehouseFilter] = useState<string>(ALL_WAREHOUSE);
  const [query, setQuery] = useState<string>("");

  const load = () => {
    setLoading(true);
    setError(null);
    fetchChemicalOverview()
      .then(setData)
      .catch((e) => setError(e?.message || "Failed to load stock"))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  // Filtered totals respect the warehouse filter; the search query
  // narrows the table but the chart always shows the chosen warehouse.
  const filteredItems = useMemo(() => {
    if (!data) return [];
    if (warehouseFilter === ALL_WAREHOUSE) return data.items;
    const byItem: Record<string, number> = {};
    for (const c of data.matrix) {
      if (c.warehouse !== warehouseFilter) continue;
      byItem[c.item_code] = (byItem[c.item_code] || 0) + c.qty;
    }
    const lookup = new Map(data.items.map((i) => [i.item_code, i]));
    return Object.entries(byItem)
      .map(([code, qty]) => {
        const base = lookup.get(code);
        return base
          ? { ...base, total_qty: qty }
          : {
              item_code: code,
              item_name: code,
              group: "",
              uom: "",
              total_qty: qty,
            };
      })
      .sort((a, b) => b.total_qty - a.total_qty);
  }, [data, warehouseFilter]);

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return filteredItems;
    return filteredItems.filter(
      (i) =>
        (i.item_name || "").toLowerCase().includes(q) ||
        (i.item_code || "").toLowerCase().includes(q),
    );
  }, [filteredItems, query]);

  const chartData = useMemo(
    () =>
      filteredItems.slice(0, CHART_TOP_N).map((i) => ({
        name: i.item_name,
        qty: Math.round(i.total_qty * 100) / 100,
        uom: i.uom,
      })),
    [filteredItems],
  );

  const overallTotals = useMemo(() => {
    if (!data) return { qty: 0, items: 0, warehouses: 0 };
    return {
      qty: data.items.reduce((s, i) => s + i.total_qty, 0),
      items: data.items.length,
      warehouses: data.warehouses.length,
    };
  }, [data]);

  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-20 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-6" />
            <div>
              <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight">
                Chemical Dashboard
              </h1>
              <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
                In-stock chemicals across all warehouses
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1 min-w-44">
              <Label htmlFor="cd-warehouse">Warehouse</Label>
              <Select
                value={warehouseFilter}
                onValueChange={setWarehouseFilter}
              >
                <SelectTrigger id="cd-warehouse" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_WAREHOUSE}>All warehouses</SelectItem>
                  {(data?.warehouses || []).map((w) => (
                    <SelectItem key={w.warehouse} value={w.warehouse}>
                      {w.warehouse}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1 min-w-56">
              <Label htmlFor="cd-search">Search</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  id="cd-search"
                  placeholder="Find a chemical…"
                  className="h-9 pl-8"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={load}
              className="h-9 gap-2"
              disabled={loading}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", loading && "animate-spin")}
              />
              Reload
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 px-4 md:px-6 py-4 md:py-6 flex flex-col gap-4">
        {error && (
          <Card className="border-destructive/40 p-3">
            <CardDescription className="text-destructive">
              {error}
            </CardDescription>
          </Card>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi
            label="Total stock"
            value={fmt(overallTotals.qty)}
            sublabel="across all warehouses"
          />
          <Kpi
            label="Chemicals"
            value={String(overallTotals.items)}
            sublabel="distinct items in stock"
          />
          <Kpi
            label="Warehouses"
            value={String(overallTotals.warehouses)}
            sublabel="holding chemical stock"
          />
          <Kpi
            label="As of"
            value={data?.as_of ? data.as_of.replace("T", " ") : "—"}
            sublabel="latest sync"
          />
        </div>

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Beaker className="h-4 w-4" />
              Top {CHART_TOP_N} chemicals by quantity
            </CardTitle>
            <CardDescription>
              {warehouseFilter === ALL_WAREHOUSE
                ? "Summed across every warehouse holding stock."
                : `Stock held in ${warehouseFilter}.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {chartData.length ? (
              <ChartContainer config={config} className="w-full h-72">
                <BarChart
                  data={chartData}
                  margin={{ left: 12, right: 12, top: 8, bottom: 12 }}
                >
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="name"
                    tickLine={false}
                    axisLine={false}
                    interval={0}
                    tick={{ fontSize: 10 }}
                    angle={-25}
                    height={64}
                    textAnchor="end"
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={56}
                    tickFormatter={(v: number) => fmt(v)}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(v, _name, item) => {
                          const payload = (item as { payload?: { uom?: string } })
                            ?.payload;
                          const uom = payload?.uom || "";
                          return `${fmt(Number(v))} ${uom}`.trim();
                        }}
                      />
                    }
                  />
                  <Bar dataKey="qty" fill="var(--color-qty)" radius={4} />
                </BarChart>
              </ChartContainer>
            ) : (
              <div className="text-xs text-muted-foreground py-8 text-center">
                {loading ? "Loading stock…" : "No chemicals in stock."}
              </div>
            )}
          </CardContent>
        </Card>

        <ChemicalStoreComparison />

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-base">Stock by chemical</CardTitle>
            <CardDescription>
              {visibleRows.length} chemical
              {visibleRows.length === 1 ? "" : "s"} ·{" "}
              {warehouseFilter === ALL_WAREHOUSE
                ? "all warehouses"
                : warehouseFilter}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[0.7rem] uppercase tracking-wide text-muted-foreground border-b">
                  <tr>
                    <th className="text-left px-4 py-2">Chemical</th>
                    <th className="text-left px-4 py-2">Group</th>
                    <th className="text-right px-4 py-2">Qty</th>
                    <th className="text-left px-4 py-2">UoM</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((i) => (
                    <tr
                      key={i.item_code}
                      className="border-b last:border-0 hover:bg-muted/40"
                    >
                      <td className="px-4 py-2">
                        <div className="font-medium">{i.item_name}</div>
                        <div className="text-[0.65rem] text-muted-foreground">
                          {i.item_code}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        <Badge variant="outline" className="text-[0.65rem]">
                          {i.group || "—"}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium">
                        {fmt(i.total_qty)}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {i.uom || "—"}
                      </td>
                    </tr>
                  ))}
                  {!visibleRows.length && (
                    <tr>
                      <td
                        colSpan={4}
                        className="px-4 py-6 text-center text-xs text-muted-foreground"
                      >
                        {loading
                          ? "Loading…"
                          : "No chemicals match the current filter."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  sublabel,
}: {
  label: string;
  value: string;
  sublabel?: string;
}) {
  return (
    <Card>
      <CardContent className="py-3 px-4 flex flex-col gap-0.5">
        <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground font-semibold">
          {label}
        </div>
        <div className="text-lg font-semibold tabular-nums leading-tight">
          {value}
        </div>
        {sublabel ? (
          <div className="text-[0.65rem] text-muted-foreground">
            {sublabel}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
