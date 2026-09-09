import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Loader2,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  fetchPlannedItems,
  fetchPlannedTransfers,
} from "@/lib/store-keeper-api";
import {
  plannedDay,
  plannedSummary,
  topTotals,
  type PlannedItem,
  type PlannedRow,
  type PlannedTotal,
} from "@/lib/planned-chemicals";
import { errorText } from "@/lib/errors";

/**
 * What is coming, once the General Manager approves it.
 *
 * The list above this one is the keeper's work: draft transfers they can
 * authorise and issue. But a draft transfer only comes into being at the moment
 * of approval, so everything still pending was invisible here — the store found
 * out what a plan needed on the day it was released. This section shows that
 * demand early and does nothing else with it: no selection, no assignment, no
 * submit. It is deliberately quieter than the list above so the two are never
 * mistaken for one another.
 */

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

type ItemsState = PlannedItem[] | "loading" | "error" | undefined;

export function PlannedChemicalsPanel({
  farm,
  fromDate,
  toDate,
}: {
  farm?: string;
  fromDate?: string;
  toDate?: string;
}) {
  const [rows, setRows] = useState<PlannedRow[]>([]);
  const [totals, setTotals] = useState<PlannedTotal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [itemsByWo, setItemsByWo] = useState<Record<string, ItemsState>>({});

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchPlannedTransfers({
      farm: farm || undefined,
      from_date: fromDate || undefined,
      to_date: toDate || undefined,
    })
      .then((resp) => {
        setRows(resp.rows || []);
        setTotals(resp.totals || []);
        // The chemicals under a row belong to the filter that produced it.
        setExpanded(new Set());
        setItemsByWo({});
      })
      .catch((e) => setError(errorText(e, "Failed to load planned chemicals")))
      .finally(() => setLoading(false));
  }, [farm, fromDate, toDate]);

  useEffect(load, [load]);

  const toggleExpand = (wo: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(wo)) {
        next.delete(wo);
        return next;
      }
      next.add(wo);
      if (itemsByWo[wo] === undefined || itemsByWo[wo] === "error") {
        setItemsByWo((m) => ({ ...m, [wo]: "loading" }));
        fetchPlannedItems(wo)
          .then((items) => setItemsByWo((m) => ({ ...m, [wo]: items })))
          .catch(() => setItemsByWo((m) => ({ ...m, [wo]: "error" })));
      }
      return next;
    });
  };

  const summary = plannedSummary(rows);
  const { shown, extraCount } = topTotals(totals);

  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardList className="h-4 w-4" />
          Planned chemicals
        </CardTitle>
        <CardDescription>
          {loading ? "Loading…" : summary.label}
          {!loading && summary.plans > 0 ? ` · ${fmt(summary.totalQty)} total` : ""}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 p-4 pt-2">
        <div className="flex items-start gap-2 rounded-md border border-[var(--sd-data-amber)]/60 bg-[var(--sd-bg-soft)] px-3 py-2 text-xs">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-[var(--sd-data-amber)]" />
          <span>
            Awaiting General Manager approval — view only. These quantities are
            what each plan has asked for; nothing here can be issued until the
            plan is approved, at which point it appears in the transfers above.
          </span>
        </div>

        {error && <div className="text-xs text-destructive">{error}</div>}

        {shown.length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {shown.map((t) => (
              <span key={`${t.item_code}-${t.uom}`} className="flex items-baseline gap-1">
                <span className="text-muted-foreground">{t.item_name}</span>
                <span className="font-medium tabular-nums">{fmt(t.total_qty)}</span>
                <span className="text-[0.65rem] text-muted-foreground">{t.uom}</span>
              </span>
            ))}
            {extraCount > 0 && (
              <span className="text-[0.7rem] text-muted-foreground italic">
                +{extraCount} more chemical{extraCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[0.7rem] uppercase tracking-wide text-muted-foreground border-b">
              <tr>
                <th className="px-2 py-2 w-7"></th>
                <th className="text-left px-3 py-2">Date</th>
                <th className="text-left px-3 py-2">Work Order</th>
                <th className="text-left px-3 py-2">Farm</th>
                <th className="text-left px-3 py-2">Greenhouse</th>
                <th className="text-right px-3 py-2">Chemicals</th>
                <th className="text-right px-3 py-2">Qty</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = expanded.has(r.work_order);
                const items = itemsByWo[r.work_order];
                return (
                  <>
                    <tr
                      key={r.work_order}
                      className="border-b last:border-0 hover:bg-muted/40 cursor-pointer"
                      onClick={() => toggleExpand(r.work_order)}
                      title={isOpen ? "Hide chemicals" : "Show chemicals"}
                    >
                      <td className="px-2 py-2 text-muted-foreground">
                        {isOpen ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {plannedDay(r.planned_date)}
                      </td>
                      <td className="px-3 py-2 font-mono text-[0.7rem] text-muted-foreground">
                        {r.work_order}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className="text-[0.65rem]">
                          {r.farm || "—"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-[0.7rem] text-muted-foreground">
                        <div className="truncate max-w-56">{r.greenhouse || "—"}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.item_count}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium">
                        {fmt(r.total_qty)}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b last:border-0 bg-muted/30">
                        <td colSpan={7} className="px-6 py-3">
                          {items === "loading" ? (
                            <div className="text-xs text-muted-foreground flex items-center gap-2">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              Loading chemicals…
                            </div>
                          ) : items === "error" ? (
                            <div className="text-xs text-destructive">
                              Failed to load chemicals.
                            </div>
                          ) : !items || !items.length ? (
                            <div className="text-xs text-muted-foreground italic">
                              No chemicals on this plan.
                            </div>
                          ) : (
                            <table className="w-full text-xs">
                              <thead className="text-[0.65rem] uppercase tracking-wide text-muted-foreground border-b">
                                <tr>
                                  <th className="text-left px-2 py-1">Chemical</th>
                                  <th className="text-right px-2 py-1">Planned qty</th>
                                  <th className="text-left px-2 py-1">UoM</th>
                                  <th className="text-left px-2 py-1">From store</th>
                                </tr>
                              </thead>
                              <tbody>
                                {items.map((it, i) => (
                                  <tr
                                    key={`${it.item_code}-${i}`}
                                    className="border-b last:border-0"
                                  >
                                    <td className="px-2 py-1">
                                      <div className="font-medium">{it.item_name}</div>
                                      <div className="text-[0.6rem] text-muted-foreground font-mono">
                                        {it.item_code}
                                      </div>
                                    </td>
                                    <td className="px-2 py-1 text-right tabular-nums font-medium">
                                      {fmt(it.qty)}
                                    </td>
                                    <td className="px-2 py-1">{it.uom}</td>
                                    <td className="px-2 py-1 text-muted-foreground truncate max-w-44">
                                      {it.from_warehouse || "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
              {/* Only when we actually know. A failed load leaves the table
                  empty, and saying "nothing is waiting" there would report an
                  outage as an all-clear — the keeper would prepare nothing. */}
              {!rows.length && !loading && !error && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-6 text-center text-xs text-muted-foreground italic"
                  >
                    No plans are waiting for approval.
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
