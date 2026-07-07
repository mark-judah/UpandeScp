/**
 * One store-type bucket (Chemical Stores / Fertilizer Stores) from
 * ``chemical_stock_overview``'s ``buckets`` payload — already scoped
 * server-side to the caller's allowed farms.
 *
 * Renders a total-qty KPI, a per-store table and a bar chart (qty per
 * store). Degrades to an empty state (not a crash) when the bucket has no
 * stores — e.g. a Store Keeper with no assigned farm.
 */
import { useMemo } from "react";
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
import type { StoreBucket } from "@/lib/store-keeper-api";

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
}: {
  title: string;
  bucket: StoreBucket | null | undefined;
  loading?: boolean;
}) {
  const stores = bucket?.stores || [];

  const barData = useMemo(
    () =>
      stores.map((s) => ({
        warehouse: s.warehouse,
        qty: Math.round(s.total_qty * 100) / 100,
        item_count: s.item_count,
      })),
    [stores],
  );

  const chartConfig: ChartConfig = {
    qty: { label: "Stock", color: PALETTE[0] },
  };

  const empty = !stores.length;

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

        {/* Table: store · total qty · item count */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[0.7rem] uppercase tracking-wide text-muted-foreground border-b">
              <tr>
                <th className="text-left px-4 py-2">Store</th>
                <th className="text-right px-4 py-2">Total qty</th>
                <th className="text-right px-4 py-2">Items</th>
              </tr>
            </thead>
            <tbody>
              {stores.map((s) => (
                <tr
                  key={s.warehouse}
                  className="border-b last:border-0 hover:bg-muted/40"
                >
                  <td className="px-4 py-2 font-medium">{s.warehouse}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {fmt(s.total_qty)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                    {s.item_count}
                  </td>
                </tr>
              ))}
              {!stores.length && (
                <tr>
                  <td
                    colSpan={3}
                    className="px-4 py-6 text-center text-xs text-muted-foreground"
                  >
                    {loading ? "Loading…" : "No stores in scope."}
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
