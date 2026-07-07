/**
 * One store-type bucket (Chemical Stores / Fertilizer Stores) from
 * ``chemical_stock_overview``'s ``buckets`` payload — already scoped
 * server-side to the caller's allowed farms.
 *
 * Renders a total-qty KPI, a chemical selector, a bar chart (qty per store,
 * for the selected chemical or all of them combined) and a chemical × store
 * matrix table. Degrades to an empty state (not a crash) when the bucket has
 * no stores — e.g. a Store Keeper with no assigned farm.
 */
import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import { PackageSearch } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import type { StoreBucket } from "@/lib/store-keeper-api";

const ALL_CHEMICALS = "__all__";

// Same series palette used by ChemicalStoreComparison.tsx / CsuLevels.tsx.
const PALETTE = [
  "var(--sd-data-cyan, #06b6d4)",
  "var(--sd-data-amber, #f59e0b)",
  "var(--sd-data-violet, #8b5cf6)",
  "var(--sd-data-green, #10b981)",
  "var(--sd-data-red, #ef4444)",
];

function fmt(n: number): string {
  if (!n) return "0";
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, {
    maximumFractionDigits: 0,
  });
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function StoreBucketPanel({
  title,
  bucket,
  loading,
  itemNames,
}: {
  title: string;
  bucket: StoreBucket | null | undefined;
  loading?: boolean;
  itemNames?: Record<string, string>;
}) {
  const [selected, setSelected] = useState<string>(ALL_CHEMICALS);

  const items = bucket?.items || [];
  const stores = bucket?.stores || [];
  const matrix = bucket?.matrix || [];

  const nameOf = (code: string) => itemNames?.[code] || code;

  const qtyByItemStore = useMemo(() => {
    const map: Record<string, Record<string, number>> = {};
    for (const m of matrix) {
      (map[m.item_code] ||= {})[m.warehouse] = m.qty;
    }
    return map;
  }, [matrix]);

  const options = useMemo(
    () =>
      [...items]
        .sort((a, b) => b.total_qty - a.total_qty)
        .map((i) => ({ value: i.item_code, label: nameOf(i.item_code) })),
    [items, itemNames],
  );

  const barData = useMemo(
    () =>
      stores.map((s) => ({
        warehouse: s.warehouse,
        qty:
          selected === ALL_CHEMICALS
            ? Math.round(s.total_qty * 100) / 100
            : Math.round((qtyByItemStore[selected]?.[s.warehouse] || 0) * 100) / 100,
        item_count: s.item_count,
      })),
    [stores, selected, qtyByItemStore],
  );

  const matrixRows = useMemo(
    () =>
      selected === ALL_CHEMICALS
        ? items
        : items.filter((i) => i.item_code === selected),
    [items, selected],
  );

  const chartConfig: ChartConfig = {
    qty: { label: "Stock", color: PALETTE[0] },
  };

  const empty = !stores.length;
  const selectId = `sbp-chemical-${title.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <PackageSearch className="h-4 w-4" />
          {title}
        </CardTitle>
        <CardDescription>
          {empty
            ? loading
              ? "Loading…"
              : "No stores in scope."
            : `${stores.length} store${stores.length === 1 ? "" : "s"} · ${fmt(bucket?.total_qty || 0)} total qty`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="rounded-md border bg-muted/20 px-4 py-3 flex flex-col gap-0.5 w-fit min-w-40">
          <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground font-semibold">
            Total stock
          </div>
          <div className="text-xl font-semibold tabular-nums leading-tight">
            {fmt(bucket?.total_qty || 0)}
          </div>
        </div>

        {!empty && (
          <div className="flex flex-col gap-1 max-w-72">
            <Label htmlFor={selectId}>Chemical</Label>
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger id={selectId} className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_CHEMICALS}>All chemicals</SelectItem>
                {options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {empty ? (
          <div className="text-xs text-muted-foreground py-8 text-center">
            {loading ? "Loading stock…" : "No stores in scope for this bucket."}
          </div>
        ) : (
          <div className="min-w-0">
            <ChartContainer config={chartConfig} className="w-full h-64">
              <BarChart
                data={barData}
                margin={{ left: 12, right: 12, top: 8, bottom: 24 }}
              >
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="warehouse"
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
                <Bar dataKey="qty" fill={PALETTE[0]} radius={4} />
              </BarChart>
            </ChartContainer>
          </div>
        )}

        {/* Matrix table: chemical × store, plus a total column */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[0.7rem] uppercase tracking-wide text-muted-foreground border-b">
              <tr>
                <th className="text-left px-4 py-2">Chemical</th>
                {stores.map((s) => (
                  <th key={s.warehouse} className="text-right px-4 py-2">
                    {s.warehouse}
                  </th>
                ))}
                <th className="text-right px-4 py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {matrixRows.map((i) => (
                <tr
                  key={i.item_code}
                  className="border-b last:border-0 hover:bg-muted/40"
                >
                  <td className="px-4 py-2">
                    <div className="font-medium">{nameOf(i.item_code)}</div>
                    <div className="text-[0.65rem] text-muted-foreground">
                      {i.item_code}
                    </div>
                  </td>
                  {stores.map((s) => {
                    const qty = qtyByItemStore[i.item_code]?.[s.warehouse] || 0;
                    return (
                      <td
                        key={s.warehouse}
                        className="px-4 py-2 text-right tabular-nums"
                      >
                        {qty ? (
                          fmt(qty)
                        ) : (
                          <span className="text-muted-foreground">·</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-4 py-2 text-right tabular-nums font-bold">
                    {fmt(i.total_qty)}
                  </td>
                </tr>
              ))}
              {!matrixRows.length && (
                <tr>
                  <td
                    colSpan={stores.length + 2}
                    className="px-4 py-6 text-center text-xs text-muted-foreground"
                  >
                    {loading ? "Loading…" : "No chemicals in scope."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
