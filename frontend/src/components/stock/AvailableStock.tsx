import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CreatorStockOverview } from "@/lib/spray-plan-creator-api";
import { buildStockItems } from "@/lib/stock-map";
import { StockTreemap } from "@/components/stock/StockTreemap";
import { StockSummaryPanel } from "@/components/stock/StockSummaryPanel";
import { ChartSkeleton } from "@/components/Loading";

/** "Available stock" tab: treemap on the left, summary of the highlighted
 *  chemical (or the whole page) on the right. */
export function AvailableStock({
  data,
  loading,
}: {
  data: CreatorStockOverview | null;
  loading: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const items = useMemo(() => buildStockItems(data), [data]);
  const farmOf = useMemo(() => {
    const m: Record<string, Record<string, { qty: number; value: number }>> = {};
    for (const w of data?.chemical_stores ?? [])
      for (const i of w.items) {
        const f = ((m[i.item_code] ||= {})[w.farm || ""] ||= { qty: 0, value: 0 });
        f.qty += i.qty;
        f.value += i.value ?? 0;
      }
    return m;
  }, [data]);
  const unvalued = items.filter((i) => i.value <= 0).length;

  const activeCode = hovered ?? selected;
  const active = items.find((i) => i.item_code === activeCode) ?? null;

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Chemicals in stock</CardTitle>
          <CardDescription className="text-[0.7rem]">
            Tile size is stock value in your chemical stores; colour is how fresh the stock is.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <ChartSkeleton height={340} />
          ) : items.some((i) => i.value > 0) ? (
            <StockTreemap
              items={items}
              farmOf={farmOf}
              activeCode={activeCode}
              onHover={setHovered}
              onSelect={(c) => setSelected((s) => (s === c ? null : c))}
            />
          ) : (
            <div className="py-10 text-center text-xs text-muted-foreground">No chemicals in stock.</div>
          )}
        </CardContent>
      </Card>
      <div className="min-w-0 lg:sticky lg:top-6 lg:self-start">
        <StockSummaryPanel items={items} item={active} unvalued={unvalued} />
      </div>
    </div>
  );
}
