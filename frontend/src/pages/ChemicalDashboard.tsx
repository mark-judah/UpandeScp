import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { HeaderIconButton } from "@/components/header-controls";
import {
  fetchChemicalOverview,
  type ChemicalOverview,
  type StoreBucket,
} from "@/lib/store-keeper-api";
import { ChemicalStoreComparison } from "@/components/ChemicalStoreComparison";
import { CsuLevels } from "@/components/CsuLevels";
import { StoreBucketPanel } from "@/components/StoreBucketPanel";
import { cn } from "@/lib/utils";

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

  const itemNames = useMemo(
    () =>
      Object.fromEntries((data?.items || []).map((i) => [i.item_code, i.item_name])),
    [data],
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
      <PageHeader
        title="Chemical Dashboard"
        eyebrow="In-stock chemicals across all warehouses"
      >
        <div className="relative min-w-56">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            aria-label="Search"
            placeholder="Find a chemical…"
            className="h-9 pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <HeaderIconButton onClick={load} title="Reload" disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </HeaderIconButton>
      </PageHeader>

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

        <div className="flex flex-col gap-4">
          <StoreBucketPanel
            title="Chemical Stores"
            bucket={data?.buckets?.chemical}
            loading={loading}
            itemNames={itemNames}
          />
          <StoreBucketPanel
            title="Fertilizer Stores"
            bucket={data?.buckets?.fertilizer}
            loading={loading}
            itemNames={itemNames}
          />
        </div>

        <CsuLevels data={data} loading={loading} />

        <ChemicalStoreComparison />

        <BucketMatrixTable
          title="Chemicals by store"
          bucket={data?.buckets?.chemical}
          itemNames={itemNames}
          query={query}
          loading={loading}
        />
        <BucketMatrixTable
          title="Fertilizers by store"
          bucket={data?.buckets?.fertilizer}
          itemNames={itemNames}
          query={query}
          loading={loading}
        />
      </div>
    </div>
  );
}

/** Chemical/fertilizer × store matrix for the assigned farms' mapped
 *  stores, with a Total column across those stores. `bucket` is already
 *  farm-scoped server-side. */
function BucketMatrixTable({
  title,
  bucket,
  itemNames,
  query,
  loading,
}: {
  title: string;
  bucket: StoreBucket | null | undefined;
  itemNames: Record<string, string>;
  query: string;
  loading?: boolean;
}) {
  const stores = bucket?.stores || [];
  const items = bucket?.items || [];
  const matrix = bucket?.matrix || [];

  const nameOf = (code: string) => itemNames[code] || code;

  const qtyByItemStore = useMemo(() => {
    const map: Record<string, Record<string, number>> = {};
    for (const m of matrix) {
      (map[m.item_code] ||= {})[m.warehouse] = m.qty;
    }
    return map;
  }, [matrix]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? items.filter(
          (i) =>
            nameOf(i.item_code).toLowerCase().includes(q) ||
            i.item_code.toLowerCase().includes(q),
        )
      : items;
    return [...filtered].sort((a, b) => b.total_qty - a.total_qty);
  }, [items, itemNames, query]);

  const empty = !stores.length;

  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>
          {rows.length} item{rows.length === 1 ? "" : "s"} · {stores.length}{" "}
          store{stores.length === 1 ? "" : "s"}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
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
              {rows.map((i) => (
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
              {!rows.length && (
                <tr>
                  <td
                    colSpan={stores.length + 2}
                    className="px-4 py-6 text-center text-xs text-muted-foreground"
                  >
                    {loading
                      ? "Loading…"
                      : empty
                        ? "No stores in scope."
                        : "No chemicals match."}
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
