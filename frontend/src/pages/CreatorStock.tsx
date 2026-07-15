/**
 * Spray Plan Creator stock dashboard.
 *
 * Two distinct inventory tiers surface here, each with its own signal:
 *
 *  • Chemical Stores  — durable storage. Low-stock thresholds and the
 *                       bullet chart apply *only* here.
 *  • CSUs (mixing units) — volatile working stock. The signal is age
 *                       ("stuff sitting > 3 days"), NOT threshold-based.
 *
 * Layout, top to bottom:
 *   1. Alerts card  — specific actionable issues across both tiers.
 *   2. KPI strip   — totals + alert counts.
 *   3. Stock health bullet chart — chemical stores only, risk-first.
 *   4. CSU section — per-warehouse expanders with aged-batch badges.
 *   5. Chemical Store section — per-warehouse expanders with LOW badges.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Building2,
  ChevronDown,
  Clock,
  RefreshCw,
  Search,
  Warehouse as WarehouseIcon,
} from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  fetchCreatorStockOverview,
  type ChemicalStoreItem,
  type CreatorStockOverview,
  type CreatorStockWarehouseCsu,
  type CreatorStockWarehouseStore,
  type CsuCohort,
  type CsuItem,
} from "@/lib/spray-plan-creator-api";
import { cn } from "@/lib/utils";

interface BulletRow {
  item_code: string;
  item_name: string;
  group: string;
  uom: string;
  total_qty: number;
  threshold: number;
  low: boolean;
}

/** Bullet-chart aggregation deliberately excludes CSU stock — CSUs are
 *  consumption-side and their fill doesn't reflect the operator's actual
 *  inventory position. */
function aggregateStoreBullets(data: CreatorStockOverview): BulletRow[] {
  const byCode = new Map<string, BulletRow>();
  for (const w of data.chemical_stores) {
    for (const i of w.items) {
      const row = byCode.get(i.item_code);
      if (row) {
        row.total_qty += i.qty;
      } else {
        byCode.set(i.item_code, {
          item_code: i.item_code,
          item_name: i.item_name,
          group: i.group,
          uom: i.uom,
          total_qty: i.qty,
          threshold: i.threshold,
          low: false,
        });
      }
    }
  }
  for (const r of byCode.values()) {
    r.low = r.threshold > 0 && r.total_qty > 0 && r.total_qty < r.threshold;
  }
  return [...byCode.values()];
}

function bulletSortKey(r: BulletRow): number {
  if (r.threshold <= 0) return Number.POSITIVE_INFINITY;
  return r.total_qty / r.threshold;
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1000)
    return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

interface AggregatedAlert {
  kind: "low" | "aged";
  item_code: string;
  item_name: string;
  warehouse: string;
  qty: number;
  uom: string;
  threshold?: number;
}

function collectAlerts(data: CreatorStockOverview): AggregatedAlert[] {
  const out: AggregatedAlert[] = [];
  for (const w of data.chemical_stores) {
    for (const i of w.items) {
      if (i.low) {
        out.push({
          kind: "low",
          item_code: i.item_code,
          item_name: i.item_name,
          warehouse: w.warehouse,
          qty: i.qty,
          uom: i.uom,
          threshold: i.threshold,
        });
      }
    }
  }
  for (const w of data.csus) {
    for (const i of w.items) {
      // For CSU alerts the urgent number is the expired portion, not
      // the full Bin qty — the fresh half is still usable.
      if (i.aged && i.expired_qty > 0) {
        out.push({
          kind: "aged",
          item_code: i.item_code,
          item_name: i.item_name,
          warehouse: w.warehouse,
          qty: i.expired_qty,
          uom: i.uom,
        });
      }
    }
  }
  return out;
}

export function CreatorStock() {
  const [data, setData] = useState<CreatorStockOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyAlerts, setOnlyAlerts] = useState(false);
  const ALL_FARMS = "__all_farms";
  const [selectedFarm, setSelectedFarm] = useState<string>(ALL_FARMS);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchCreatorStockOverview()
      .then(setData)
      .catch((e) =>
        setError(
          e?.message ||
            "Could not load chemical stock. Ask the GM to confirm your farm assignments.",
        ),
      )
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const matchesQuery = (item_name: string, item_code: string): boolean => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      item_name.toLowerCase().includes(q) ||
      item_code.toLowerCase().includes(q)
    );
  };

  // Reset the farm pill back to "All" whenever the user's set of farms
  // changes — guards against the previously-selected farm vanishing
  // (e.g. GM revokes access mid-session). The toString() coerces the
  // farms list to a stable dependency key.
  useEffect(() => {
    if (!data) return;
    if (selectedFarm !== ALL_FARMS && !data.farms.includes(selectedFarm)) {
      setSelectedFarm(ALL_FARMS);
    }
  }, [data, selectedFarm]);

  /** Narrow the dataset to the selected farm before any other filtering
   *  happens. Everything downstream (alerts, bullets, KPIs, warehouse
   *  sections) reads from the scoped view so the farm pill is the single
   *  source of truth. */
  const scopedData = useMemo<CreatorStockOverview | null>(() => {
    if (!data) return null;
    if (selectedFarm === ALL_FARMS) return data;
    const csus = data.csus.filter((w) => w.farm === selectedFarm);
    const stores = data.chemical_stores.filter(
      (w) => w.farm === selectedFarm,
    );
    return {
      ...data,
      csus,
      chemical_stores: stores,
      farms: data.farms,
      low_stock_count: stores.reduce(
        (s, w) => s + w.items.filter((i) => i.low).length,
        0,
      ),
      aged_csu_count: csus.reduce((s, w) => s + w.aged_count, 0),
    };
  }, [data, selectedFarm]);

  const filteredCsus = useMemo<CreatorStockWarehouseCsu[]>(() => {
    if (!scopedData) return [];
    return scopedData.csus
      .map((wh) => ({
        ...wh,
        items: wh.items.filter((i) => {
          if (onlyAlerts && !i.aged) return false;
          return matchesQuery(i.item_name, i.item_code);
        }),
      }))
      .filter((wh) => wh.items.length > 0);
  }, [scopedData, query, onlyAlerts]);

  const filteredStores = useMemo<CreatorStockWarehouseStore[]>(() => {
    if (!scopedData) return [];
    return scopedData.chemical_stores
      .map((wh) => ({
        ...wh,
        items: wh.items.filter((i) => {
          if (onlyAlerts && !i.low) return false;
          return matchesQuery(i.item_name, i.item_code);
        }),
      }))
      .filter((wh) => wh.items.length > 0);
  }, [scopedData, query, onlyAlerts]);

  const bullets = useMemo(() => {
    if (!scopedData) return [] as BulletRow[];
    const rows = aggregateStoreBullets(scopedData).filter((r) => r.total_qty > 0);
    const filtered = rows.filter((r) => {
      if (onlyAlerts && !r.low) return false;
      return matchesQuery(r.item_name, r.item_code);
    });
    return filtered.sort((a, b) => bulletSortKey(a) - bulletSortKey(b));
  }, [scopedData, query, onlyAlerts]);

  const alerts = useMemo(
    () => (scopedData ? collectAlerts(scopedData) : []),
    [scopedData],
  );

  const totals = useMemo(() => {
    if (!scopedData) return { csu: 0, store: 0, expired: 0 };
    return {
      csu: scopedData.csus.reduce((s, w) => s + w.total_qty, 0),
      store: scopedData.chemical_stores.reduce((s, w) => s + w.total_qty, 0),
      expired: scopedData.csus.reduce(
        (s, w) => s + w.items.reduce((ws, i) => ws + i.expired_qty, 0),
        0,
      ),
    };
  }, [scopedData]);

  const alertTotal =
    (scopedData?.low_stock_count ?? 0) + (scopedData?.aged_csu_count ?? 0);

  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-20 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-6" />
            <div>
              <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight">
                Chemical Stock
              </h1>
              <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
                Chemical store inventory · CSU consumption window
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Find a chemical…"
                className="h-9 pl-8 min-w-56"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Button
              variant={onlyAlerts ? "default" : "outline"}
              size="sm"
              onClick={() => setOnlyAlerts((v) => !v)}
              className={cn(
                "h-9 gap-2",
                onlyAlerts && "bg-amber-500 hover:bg-amber-500/90 text-white",
              )}
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              {onlyAlerts ? "Alerts only" : "Alerts"}
              {alertTotal > 0 ? (
                <span
                  className={cn(
                    "ml-0.5 rounded-full px-1.5 text-[0.6rem] font-semibold tabular-nums",
                    onlyAlerts
                      ? "bg-white/20 text-white"
                      : "bg-amber-500/20 text-amber-700",
                  )}
                >
                  {alertTotal}
                </span>
              ) : null}
            </Button>
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

        {data && data.farms.length > 1 && (
          <FarmSwitcher
            farms={data.farms}
            selected={selectedFarm}
            allValue={ALL_FARMS}
            onSelect={setSelectedFarm}
          />
        )}

        <AlertsCard
          alerts={alerts}
          loading={loading}
          csuMaxAgeDays={data?.csu_max_age_days ?? 3}
        />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi
            label="Low-stock items"
            value={String(scopedData?.low_stock_count ?? 0)}
            sublabel="chemical stores below threshold"
            accent={scopedData?.low_stock_count ? "warn" : undefined}
          />
          <Kpi
            label="Aged CSU batches"
            value={String(scopedData?.aged_csu_count ?? 0)}
            sublabel={`sitting > ${data?.csu_max_age_days ?? 3} days`}
            accent={scopedData?.aged_csu_count ? "warn" : undefined}
          />
          <Kpi
            label="Chemical store stock"
            value={fmt(totals.store)}
            sublabel={`${scopedData?.chemical_stores.length ?? 0} store${
              (scopedData?.chemical_stores.length ?? 0) === 1 ? "" : "s"
            }`}
          />
          <Kpi
            label="CSU stock"
            value={fmt(totals.csu)}
            sublabel={
              totals.expired > 0
                ? `${fmt(totals.expired)} expired · ${fmt(
                    totals.csu - totals.expired,
                  )} fresh`
                : `${scopedData?.csus.length ?? 0} CSU${
                    (scopedData?.csus.length ?? 0) === 1 ? "" : "s"
                  } · consumption only`
            }
            accent={totals.expired > 0 ? "warn" : undefined}
          />
        </div>

        <StockHealthCard rows={bullets} loading={loading} />

        <CsuSection
          rows={filteredCsus}
          loading={loading}
          filtered={Boolean(query || onlyAlerts)}
          csuMaxAgeDays={data?.csu_max_age_days ?? 3}
        />

        <StoreSection
          rows={filteredStores}
          loading={loading}
          filtered={Boolean(query || onlyAlerts)}
        />

        {data?.as_of && (
          <div className="text-[0.65rem] text-muted-foreground text-right">
            As of {data.as_of.replace("T", " ")}
          </div>
        )}
      </div>
    </div>
  );
}

function AlertsCard({
  alerts,
  loading,
  csuMaxAgeDays,
}: {
  alerts: AggregatedAlert[];
  loading: boolean;
  csuMaxAgeDays: number;
}) {
  const lowCount = alerts.filter((a) => a.kind === "low").length;
  const agedCount = alerts.filter((a) => a.kind === "aged").length;

  if (loading && alerts.length === 0) {
    return null;
  }

  if (alerts.length === 0) {
    return (
      <Card className="border-emerald-500/30 bg-emerald-500/5">
        <CardContent className="py-3 px-4 flex items-center gap-3">
          <div className="h-2.5 w-2.5 rounded-full bg-emerald-500 shrink-0" />
          <div>
            <div className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
              All clear
            </div>
            <div className="text-[0.7rem] text-muted-foreground">
              No low-stock or aged-batch alerts across your farms.
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-amber-500/40 bg-amber-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4" />
          Alerts
          <span className="ml-auto inline-flex items-center gap-2 text-[0.7rem] font-normal">
            {lowCount > 0 && (
              <span className="inline-flex items-center gap-1 text-amber-700">
                <AlertTriangle className="h-3 w-3" />
                {lowCount} low
              </span>
            )}
            {agedCount > 0 && (
              <span className="inline-flex items-center gap-1 text-orange-700">
                <Clock className="h-3 w-3" />
                {agedCount} aged
              </span>
            )}
          </span>
        </CardTitle>
        <CardDescription className="text-[0.7rem]">
          Stock that needs attention. Low = chemical store qty below the
          GM-set threshold. Aged = CSU stock sitting unused for at least{" "}
          {csuMaxAgeDays} days.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-amber-500/15">
          {alerts.slice(0, 12).map((a, idx) => (
            <AlertRow key={`${a.kind}-${a.item_code}-${a.warehouse}-${idx}`} alert={a} />
          ))}
          {alerts.length > 12 && (
            <div className="px-4 py-2 text-[0.65rem] text-muted-foreground">
              + {alerts.length - 12} more — use the alerts filter or search to
              narrow.
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function AlertRow({ alert }: { alert: AggregatedAlert }) {
  const Icon = alert.kind === "aged" ? Clock : AlertTriangle;
  const tone =
    alert.kind === "aged" ? "text-orange-700" : "text-amber-700";
  return (
    <div className="flex items-center gap-3 px-4 py-2 text-xs">
      <Icon className={cn("h-3.5 w-3.5 shrink-0", tone)} />
      <div className="min-w-0 flex-1">
        <div className="font-medium truncate">{alert.item_name}</div>
        <div className="text-[0.65rem] text-muted-foreground truncate">
          {alert.warehouse}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className={cn("text-xs tabular-nums font-semibold", tone)}>
          {fmt(alert.qty)}{" "}
          <span className="text-[0.6rem] font-normal text-muted-foreground">
            {alert.uom}
          </span>
        </div>
        {alert.kind === "low" && alert.threshold ? (
          <div className="text-[0.6rem] text-muted-foreground">
            threshold {fmt(alert.threshold)} {alert.uom}
          </div>
        ) : alert.kind === "aged" ? (
          <div className="text-[0.6rem] text-muted-foreground">
            in CSU
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StockHealthCard({
  rows,
  loading,
}: {
  rows: BulletRow[];
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <WarehouseIcon className="h-4 w-4" />
          Chemical store health
          <span className="ml-auto text-[0.7rem] font-normal text-muted-foreground">
            {rows.length} chemical{rows.length === 1 ? "" : "s"} · at-risk first
          </span>
        </CardTitle>
        <CardDescription className="text-[0.7rem]">
          Total stock across your chemical stores. The tick marks the GM's
          low-stock threshold &mdash; bars that fall short of it are amber.
          CSU consumption stock is intentionally excluded.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-2 py-2">
        {rows.length === 0 ? (
          <div className="text-xs text-muted-foreground py-6 text-center">
            {loading ? "Loading…" : "No chemicals in stock."}
          </div>
        ) : (
          <div className="flex flex-col">
            {rows.map((r) => (
              <BulletBar key={r.item_code} row={r} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BulletBar({ row }: { row: BulletRow }) {
  // Per-row scale: 1.15× current qty or 2.5× threshold, whichever is
  // larger. Once the loaning feature lands and the GM sets a per-chemical
  // 100% baseline, swap that in here as the scale ceiling.
  const hasThreshold = row.threshold > 0;
  const scale = hasThreshold
    ? Math.max(row.total_qty * 1.15, row.threshold * 2.5)
    : Math.max(row.total_qty, 1);
  const fillPct = hasThreshold
    ? Math.min(100, (row.total_qty / scale) * 100)
    : 60;
  const tickPct = hasThreshold
    ? Math.min(100, (row.threshold / scale) * 100)
    : 0;

  return (
    <div className="grid grid-cols-[10rem_1fr_7rem] gap-3 items-center px-2 py-1.5 rounded-md hover:bg-muted/30 transition-colors">
      <div className="min-w-0">
        <div className="text-xs font-medium truncate" title={row.item_name}>
          {row.item_name}
        </div>
        <div className="text-[0.6rem] text-muted-foreground truncate">
          {row.group || "—"}
        </div>
      </div>
      <div className="relative h-3 rounded-full bg-muted overflow-visible">
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full transition-all",
            row.low
              ? "bg-amber-500"
              : hasThreshold
                ? "bg-emerald-500/80"
                : "bg-muted-foreground/30",
          )}
          style={{ width: `${fillPct}%` }}
        />
        {hasThreshold && (
          <div
            className="absolute top-[-2px] bottom-[-2px] w-px bg-foreground/70"
            style={{ left: `${tickPct}%` }}
            title={`Threshold: ${row.threshold}`}
          />
        )}
      </div>
      <div className="flex items-center justify-end gap-2">
        {row.low && (
          <Badge className="bg-amber-500/15 text-amber-700 hover:bg-amber-500/15 text-[0.55rem] px-1.5 py-0">
            LOW
          </Badge>
        )}
        <div
          className={cn(
            "text-xs tabular-nums font-semibold",
            row.low && "text-amber-700",
          )}
        >
          {fmt(row.total_qty)}
          <span className="text-[0.6rem] font-normal text-muted-foreground ml-0.5">
            {row.uom}
          </span>
        </div>
      </div>
    </div>
  );
}

function StoreSection({
  rows,
  loading,
  filtered,
}: {
  rows: CreatorStockWarehouseStore[];
  loading: boolean;
  filtered: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <WarehouseIcon className="h-4 w-4" />
          Chemical stores
          <span className="ml-auto text-[0.7rem] font-normal text-muted-foreground">
            {rows.length} location{rows.length === 1 ? "" : "s"} · storage
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="text-xs text-muted-foreground py-8 text-center">
            {loading
              ? "Loading…"
              : filtered
                ? "No chemical store rows match the current filter."
                : "No chemical store stock on hand."}
          </div>
        ) : (
          <div className="divide-y">
            {rows.map((wh) => (
              <StoreWarehouseRow key={wh.warehouse} row={wh} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StoreWarehouseRow({ row }: { row: CreatorStockWarehouseStore }) {
  const [open, setOpen] = useState(true);
  const lowCount = row.items.filter((i) => i.low).length;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-muted/40 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground transition-transform shrink-0",
              !open && "-rotate-90",
            )}
          />
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{row.warehouse}</div>
            <div className="text-[0.65rem] text-muted-foreground truncate">
              {row.farm || "—"} · {row.items.length} chemical
              {row.items.length === 1 ? "" : "s"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {lowCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 text-amber-700 px-2 py-0.5 text-[0.6rem] font-semibold">
              <AlertTriangle className="h-3 w-3" />
              {lowCount} low
            </span>
          )}
          <div className="text-xs tabular-nums font-semibold">
            {fmt(row.total_qty)}
          </div>
        </div>
      </button>
      {open && <StoreItemsTable items={row.items} />}
    </div>
  );
}

function StoreItemsTable({ items }: { items: ChemicalStoreItem[] }) {
  return (
    <div className="px-4 pb-3">
      <table className="w-full text-xs">
        <thead className="text-[0.65rem] uppercase tracking-wide text-muted-foreground border-b">
          <tr>
            <th className="text-left py-1.5">Chemical</th>
            <th className="text-left py-1.5">Group</th>
            <th className="text-right py-1.5">Qty</th>
            <th className="text-right py-1.5">Threshold</th>
            <th className="text-left py-1.5 pl-2">UoM</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr
              key={i.item_code}
              className={cn(
                "border-b last:border-0",
                i.low && "bg-amber-500/5",
              )}
            >
              <td className="py-1.5">
                <div className="font-medium flex items-center gap-1.5">
                  {i.item_name}
                  {i.low && (
                    <Badge className="bg-amber-500/15 text-amber-700 hover:bg-amber-500/15 text-[0.55rem] px-1.5 py-0">
                      LOW
                    </Badge>
                  )}
                </div>
                <div className="text-[0.6rem] text-muted-foreground font-mono">
                  {i.item_code}
                </div>
              </td>
              <td className="py-1.5">
                <Badge variant="outline" className="text-[0.6rem]">
                  {i.group || "—"}
                </Badge>
              </td>
              <td
                className={cn(
                  "py-1.5 text-right tabular-nums font-semibold",
                  i.low && "text-amber-700",
                )}
              >
                {fmt(i.qty)}
              </td>
              <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                {i.threshold > 0 ? fmt(i.threshold) : "—"}
              </td>
              <td className="py-1.5 pl-2 text-muted-foreground">
                {i.uom || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CsuSection({
  rows,
  loading,
  filtered,
  csuMaxAgeDays,
}: {
  rows: CreatorStockWarehouseCsu[];
  loading: boolean;
  filtered: boolean;
  csuMaxAgeDays: number;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="h-4 w-4" />
          CSUs &middot; mixing units
          <span className="ml-auto text-[0.7rem] font-normal text-muted-foreground">
            {rows.length} location{rows.length === 1 ? "" : "s"} · should
            consume within {csuMaxAgeDays} days
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="text-xs text-muted-foreground py-8 text-center">
            {loading
              ? "Loading…"
              : filtered
                ? "No CSU rows match the current filter."
                : "Nothing in your CSUs right now."}
          </div>
        ) : (
          <div className="divide-y">
            {rows.map((wh) => (
              <CsuWarehouseRow
                key={wh.warehouse}
                row={wh}
                csuMaxAgeDays={csuMaxAgeDays}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CsuWarehouseRow({
  row,
  csuMaxAgeDays,
}: {
  row: CreatorStockWarehouseCsu;
  csuMaxAgeDays: number;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-muted/40 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground transition-transform shrink-0",
              !open && "-rotate-90",
            )}
          />
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{row.warehouse}</div>
            <div className="text-[0.65rem] text-muted-foreground truncate">
              {row.farm || "—"} · {row.items.length} batch
              {row.items.length === 1 ? "" : "es"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {row.aged_count > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/15 text-orange-700 px-2 py-0.5 text-[0.6rem] font-semibold">
              <Clock className="h-3 w-3" />
              {row.aged_count} aged
            </span>
          )}
          <div className="text-xs tabular-nums font-semibold">
            {fmt(row.total_qty)}
          </div>
        </div>
      </button>
      {open && <CsuItemsTable items={row.items} csuMaxAgeDays={csuMaxAgeDays} />}
    </div>
  );
}

function CsuItemsTable({
  items,
  csuMaxAgeDays,
}: {
  items: CsuItem[];
  csuMaxAgeDays: number;
}) {
  return (
    <div className="px-4 pb-3">
      <table className="w-full text-xs">
        <thead className="text-[0.65rem] uppercase tracking-wide text-muted-foreground border-b">
          <tr>
            <th className="text-left py-1.5 w-6"></th>
            <th className="text-left py-1.5">Chemical</th>
            <th className="text-left py-1.5">Group</th>
            <th className="text-right py-1.5">Total</th>
            <th className="text-right py-1.5 pl-2">Expired</th>
            <th className="text-right py-1.5 pl-2">Fresh</th>
            <th className="text-left py-1.5 pl-2">UoM</th>
            <th className="text-left py-1.5 pl-2">Oldest</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <CsuItemRow
              key={i.item_code}
              item={i}
              csuMaxAgeDays={csuMaxAgeDays}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CsuItemRow({
  item: i,
  csuMaxAgeDays,
}: {
  item: CsuItem;
  csuMaxAgeDays: number;
}) {
  const [open, setOpen] = useState(false);
  const [highlightedDate, setHighlightedDate] = useState<string | null>(null);
  const hasCohorts = i.cohorts.length > 0;
  const dayGroups = useMemo(
    () => groupCohortsByDay(i.cohorts, csuMaxAgeDays),
    [i.cohorts, csuMaxAgeDays],
  );
  // Auto-clear the highlight ring after a couple of seconds so the
  // drawer doesn't permanently glow the chosen segment.
  useEffect(() => {
    if (!highlightedDate) return;
    const t = window.setTimeout(() => setHighlightedDate(null), 2400);
    return () => window.clearTimeout(t);
  }, [highlightedDate]);

  const handleSegmentClick = (date: string) => {
    setOpen(true);
    setHighlightedDate(date);
  };
  return (
    <>
      <tr
        className={cn(
          "border-b last:border-0",
          i.aged && "bg-orange-500/5",
          hasCohorts && "cursor-pointer hover:bg-muted/30",
        )}
        onClick={hasCohorts ? () => setOpen((v) => !v) : undefined}
      >
        <td className="py-1.5">
          {hasCohorts && (
            <ChevronDown
              className={cn(
                "h-3 w-3 text-muted-foreground transition-transform",
                !open && "-rotate-90",
              )}
            />
          )}
        </td>
        <td className="py-1.5">
          <div className="font-medium">{i.item_name}</div>
          <div className="text-[0.6rem] text-muted-foreground font-mono">
            {i.item_code}
          </div>
        </td>
        <td className="py-1.5">
          <Badge variant="outline" className="text-[0.6rem]">
            {i.group || "—"}
          </Badge>
        </td>
        <td
          className={cn(
            "py-1.5 text-right tabular-nums font-semibold",
            i.aged && "text-orange-700",
          )}
        >
          {fmt(i.qty)}
        </td>
        <td className="py-1.5 pl-2 text-right tabular-nums">
          {i.expired_qty > 0 ? (
            <span className="text-orange-700 font-semibold">
              {fmt(i.expired_qty)}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="py-1.5 pl-2 text-right tabular-nums">
          {i.fresh_qty > 0 ? (
            <span className="text-emerald-700">{fmt(i.fresh_qty)}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="py-1.5 pl-2 text-muted-foreground">{i.uom || "—"}</td>
        <td className="py-1.5 pl-2">
          {i.oldest_age_days >= csuMaxAgeDays ? (
            <span className="inline-flex items-center gap-1 text-[0.65rem] text-orange-700 font-semibold">
              <Clock className="h-3 w-3" />
              {fmtAge(i.oldest_age_days)}
            </span>
          ) : i.oldest_age_days > 0 ? (
            <span className="text-[0.6rem] text-muted-foreground">
              {fmtAge(i.oldest_age_days)}
            </span>
          ) : (
            <span className="text-[0.6rem] text-muted-foreground">fresh</span>
          )}
        </td>
      </tr>
      {hasCohorts && (
        <tr className="border-b last:border-0">
          <td colSpan={8} className="p-0">
            <div
              className="px-2 pb-1.5"
              onClick={(e) => e.stopPropagation()}
            >
              <DayPartitionBar
                groups={dayGroups}
                totalQty={i.qty}
                uom={i.uom}
                csuMaxAgeDays={csuMaxAgeDays}
                onSegmentClick={handleSegmentClick}
              />
            </div>
          </td>
        </tr>
      )}
      {open && hasCohorts && (
        <tr className="border-b last:border-0 bg-muted/20">
          <td colSpan={8} className="px-4 py-2">
            <CohortTimeline
              groups={dayGroups}
              uom={i.uom}
              csuMaxAgeDays={csuMaxAgeDays}
              highlightedDate={highlightedDate}
            />
          </td>
        </tr>
      )}
    </>
  );
}

interface DayGroup {
  /** YYYY-MM-DD bucket key. */
  date: string;
  /** Sum of cohort qty for this day. */
  totalQty: number;
  /** Max age across cohorts in this day (oldest moment of the day). */
  maxAgeDays: number;
  /** True if any cohort in this day has crossed csuMaxAgeDays. */
  expired: boolean;
  cohorts: CsuCohort[];
}

function groupCohortsByDay(
  cohorts: CsuCohort[],
  csuMaxAgeDays: number,
): DayGroup[] {
  const byDay = new Map<string, DayGroup>();
  for (const c of cohorts) {
    const date = c.added_on.slice(0, 10);
    const bucket = byDay.get(date);
    if (bucket) {
      bucket.totalQty += c.qty;
      bucket.maxAgeDays = Math.max(bucket.maxAgeDays, c.age_days);
      bucket.expired = bucket.expired || c.expired;
      bucket.cohorts.push(c);
    } else {
      byDay.set(date, {
        date,
        totalQty: c.qty,
        maxAgeDays: c.age_days,
        expired: c.age_days >= csuMaxAgeDays,
        cohorts: [c],
      });
    }
  }
  // Render order: oldest day on the left of the bar, mirroring the
  // FIFO reading direction ("this is going to expire first").
  return [...byDay.values()].sort((a, b) => b.maxAgeDays - a.maxAgeDays);
}

function DayPartitionBar({
  groups,
  totalQty,
  uom,
  csuMaxAgeDays,
  onSegmentClick,
}: {
  groups: DayGroup[];
  totalQty: number;
  uom: string;
  csuMaxAgeDays: number;
  onSegmentClick: (date: string) => void;
}) {
  return (
    <div
      className="h-2.5 w-full flex gap-1 items-center"
      title={`${groups.length} day group${groups.length === 1 ? "" : "s"} · click a segment to inspect`}
    >
      {groups.map((g) => {
        const color = ageColor(g.maxAgeDays, csuMaxAgeDays);
        return (
          <button
            type="button"
            key={g.date}
            onClick={(e) => {
              e.stopPropagation();
              onSegmentClick(g.date);
            }}
            className="h-full rounded-full min-w-[6px] transition-all hover:brightness-110 hover:shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 cursor-pointer"
            style={{
              flexGrow: g.totalQty,
              flexBasis: 0,
              backgroundColor: color,
              outlineColor: color,
            }}
            title={`${g.date} · ${fmt(g.totalQty)} ${uom} · ${
              g.expired
                ? `${fmtAge(g.maxAgeDays)} · expired`
                : `${fmtAge(g.maxAgeDays)} · ${
                    csuMaxAgeDays - Math.floor(g.maxAgeDays)
                  }d left`
            } — click to inspect`}
            aria-label={`Inspect batches from ${g.date}`}
          />
        );
      })}
      {totalQty <= 0 && (
        <div className="h-full w-full rounded-full bg-muted" />
      )}
    </div>
  );
}

/** HSL colour scale keyed to age vs. CSU_MAX_AGE_DAYS.
 *
 *  Fresh range (age < max): hue glides from emerald (140°) at zero age
 *  through lime (95°) to yellow (45°) as age approaches the threshold —
 *  visual "running warm".
 *  Expired range (age >= max): stays in the orange family — light orange
 *  at just-expired, darker / more saturated orange as the stock keeps
 *  ageing. Deliberately never crosses into red so the worst-case still
 *  reads as "warning" not "danger" — the user-set tone for this
 *  dashboard.
 */
function ageColor(ageDays: number, maxDays: number): string {
  const max = Math.max(1e-6, maxDays);
  if (ageDays < max) {
    const t = Math.max(0, Math.min(1, ageDays / max));
    const hue = 140 - t * 95; // 140 emerald → 45 yellow
    const sat = 70 - t * 8;
    const light = 48 - t * 4;
    return `hsl(${hue.toFixed(0)}, ${sat.toFixed(0)}%, ${light.toFixed(0)}%)`;
  }
  // Expired: stay at orange (24°). Saturate and darken with overdue
  // depth so a 6d-old batch reads as visibly worse than a 3d-old one
  // without leaving the warning palette.
  const overdue = Math.max(0, Math.min(1, (ageDays - max) / max));
  const hue = 24;
  const sat = 85 + overdue * 7;
  const light = 55 - overdue * 13; // 55% → 42%, deeper orange when overdue
  return `hsl(${hue}, ${sat.toFixed(0)}%, ${light.toFixed(0)}%)`;
}

function CohortTimeline({
  groups,
  uom,
  csuMaxAgeDays,
  highlightedDate,
}: {
  groups: DayGroup[];
  uom: string;
  csuMaxAgeDays: number;
  highlightedDate: string | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
        Batches in this CSU · grouped by day · oldest first
      </div>
      <div className="flex flex-col gap-2">
        {groups.map((g) => (
          <DayGroupCard
            key={g.date}
            group={g}
            uom={uom}
            csuMaxAgeDays={csuMaxAgeDays}
            highlighted={highlightedDate === g.date}
          />
        ))}
      </div>
    </div>
  );
}

function DayGroupCard({
  group: g,
  uom,
  csuMaxAgeDays,
  highlighted,
}: {
  group: DayGroup;
  uom: string;
  csuMaxAgeDays: number;
  highlighted: boolean;
}) {
  const tone = ageColor(g.maxAgeDays, csuMaxAgeDays);
  const ref = useRef<HTMLDivElement>(null);

  // When the segment-click marks this day as highlighted, scroll it
  // into view so the operator's eye lands on the card even if the
  // drawer's tall.
  useEffect(() => {
    if (!highlighted || !ref.current) return;
    ref.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [highlighted]);

  return (
    <div
      ref={ref}
      className={cn(
        "rounded-md border px-3 py-2 transition-shadow",
        highlighted && "ring-2 shadow-md",
      )}
      style={{
        borderColor: `${tone}55`,
        backgroundColor: `${tone}10`,
        ...(highlighted ? { boxShadow: `0 0 0 2px ${tone}` } : {}),
      }}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="h-2.5 w-2.5 rounded-full shrink-0"
            style={{ backgroundColor: tone }}
          />
          <span className="text-sm font-semibold tabular-nums">
            {fmtDayLabel(g.date)}
          </span>
          <span className="text-xs text-muted-foreground">
            {g.cohorts.length} batch{g.cohorts.length === 1 ? "" : "es"}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={cn(
              "text-sm tabular-nums font-semibold",
              g.expired ? "text-orange-700" : "text-foreground",
            )}
          >
            {fmt(g.totalQty)} {uom}
          </span>
          {g.expired ? (
            <span className="inline-flex items-center gap-1 text-xs text-orange-700 font-semibold">
              <Clock className="h-3 w-3" />
              {fmtAge(g.maxAgeDays)} · expired
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {fmtAge(g.maxAgeDays)} ·{" "}
              {csuMaxAgeDays - Math.floor(g.maxAgeDays)}d left
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-col">
        {g.cohorts.map((c, idx) => (
          <CohortLine
            key={`${c.added_on}-${idx}`}
            cohort={c}
            uom={uom}
            isFirst={idx === 0}
          />
        ))}
      </div>
    </div>
  );
}

function CohortLine({
  cohort: c,
  uom,
  isFirst,
}: {
  cohort: CsuCohort;
  uom: string;
  isFirst: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[6.5rem_3.5rem_1fr] items-center gap-x-3 py-1.5 text-xs",
        !isFirst && "border-t border-border/40",
      )}
    >
      <span
        className={cn(
          "tabular-nums font-medium",
          c.expired ? "text-orange-700" : "text-foreground",
        )}
      >
        {fmt(c.qty)} {uom}
      </span>
      <span className="text-[0.7rem] text-muted-foreground tabular-nums">
        {fmtTimeOnly(c.added_on)}
      </span>
      <span className="min-w-0 justify-self-start">
        {c.greenhouse ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-card border border-border px-2 py-0.5 text-xs font-medium max-w-full">
            <span className="text-muted-foreground">→</span>
            <span className="truncate">{c.greenhouse}</span>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground/60">—</span>
        )}
      </span>
    </div>
  );
}

function fmtDayLabel(yyyymmdd: string): string {
  // The string is already YYYY-MM-DD. Parse it as a local date so a
  // batch added on 2026-05-20 doesn't drift to "May 19" via UTC.
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  if (!y || !m || !d) return yyyymmdd;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function fmtTimeOnly(iso: string): string {
  // Pull HH:MM from the ``YYYY-MM-DDTHH:MM:SS`` ISO string.
  const part = iso.slice(11, 16);
  return part || iso;
}

function fmtAge(days: number): string {
  if (days < 1) {
    const hrs = Math.max(1, Math.round(days * 24));
    return `${hrs}h`;
  }
  if (days < 10) {
    return `${days.toFixed(1)}d`;
  }
  return `${Math.round(days)}d`;
}


function FarmSwitcher({
  farms,
  selected,
  allValue,
  onSelect,
}: {
  farms: string[];
  selected: string;
  allValue: string;
  onSelect: (next: string) => void;
}) {
  return (
    <div className="flex justify-start">
      {/* Reference `.pillgroup` switcher (native shadcn Tabs). */}
      <Tabs value={selected} onValueChange={onSelect} className="w-auto">
        <TabsList className="flex-wrap">
          <TabsTrigger value={allValue}>All Farms</TabsTrigger>
          {farms.map((f) => (
            <TabsTrigger key={f} value={f}>
              {f}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}

function Kpi({
  label,
  value,
  sublabel,
  accent,
}: {
  label: string;
  value: string;
  sublabel?: string;
  accent?: "warn";
}) {
  return (
    <Card className={cn(accent === "warn" && "border-amber-500/40")}>
      <CardContent className="py-3 px-4 flex flex-col gap-0.5">
        <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground font-semibold">
          {label}
        </div>
        <div
          className={cn(
            "text-lg font-semibold tabular-nums leading-tight",
            accent === "warn" && "text-amber-700",
          )}
        >
          {value}
        </div>
        {sublabel ? (
          <div className="text-[0.65rem] text-muted-foreground truncate">
            {sublabel}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
