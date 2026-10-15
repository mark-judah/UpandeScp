/**
 * Finances — crop-protection spend per greenhouse, broken down by the
 * pest/disease it was spent on, over a chosen period.
 *
 * Cost is the ACTUAL value of product consumed, counted once where it leaves
 * the store for use. See serverscripts/reports/finances.py (ported from mona).
 *
 * Two things this page must never hide:
 *   - a SPLIT figure, divided equally across a plan's targets because the
 *     product records none, is not a measurement and is marked as such;
 *   - spend issued straight from the store has no greenhouse and no target, and
 *     is reported as unattributed rather than given a home it never had.
 */
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { CircleSlash, Info, Split, Target, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DateRangePicker } from "@/components/DateRangePicker";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  fetchChemicalCostByTarget,
  type ChemicalCostReport,
  type CostCell,
} from "@/lib/finance-api";
import { LoadProgress, TableRowsSkeleton, TextSkeleton } from "@/components/Loading";
import { Table, TableBody } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BudgetView } from "@/components/finance/BudgetView";
import { ymd } from "@/lib/utils";

/** "target": stock leaving the store, by greenhouse and pest (the per-target
 *  breakdown). "budget": the ledger per farm against its ERPNext Budget (B7). */
type FinanceView = "target" | "budget";

function monthStart(): string {
  const d = new Date();
  return ymd(new Date(d.getFullYear(), d.getMonth(), 1));
}

const KIND_LABEL: Record<string, string> = {
  chemical: "Chemicals",
  foliar: "Foliars",
};

export function Finance({ initialCrop }: { initialCrop?: string } = {}) {
  const [view, setView] = useState<FinanceView>("target");
  const [from, setFrom] = useState<string>(monthStart);
  const [to, setTo] = useState<string>(() => ymd(new Date()));
  const [data, setData] = useState<ChemicalCostReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (view !== "target") return;
    let alive = true;
    setLoading(true);
    setError(null);
    fetchChemicalCostByTarget(from, to, initialCrop ? { crop: initialCrop } : {})
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e?.message || "Failed to load finances"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [from, to, initialCrop, view]);

  // First load: the note, the totals' labels and the tables' headings are
  // drawn and only the figures pend. A date change keeps the old report up.
  const pending = !data && !error;

  const money = useMemo(() => {
    const cur = data?.currency || "KES";
    const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
    return (n: number) => (n ? `${cur} ${fmt.format(Math.round(n))}` : "—");
  }, [data?.currency]);

  const unattributedTotal = useMemo(
    () => (data?.unattributed || []).reduce((s, u) => s + u.value, 0),
    [data],
  );

  /** Readable product name, falling back to the code when unknown. */
  const nameOf = (code: string) => data?.item_names?.[code] || code;

  function Cell({ cell }: { cell: CostCell | undefined }) {
    if (!cell || !cell.value) {
      return <span className="text-muted-foreground/40">—</span>;
    }
    if (!cell.split) return <>{money(cell.value)}</>;
    const pct = Math.round((cell.split / cell.value) * 100);
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help text-amber-700 dark:text-amber-500">
            {money(cell.value)}
            <span className="ml-1 text-[10px] font-medium align-super">~{pct}%</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="font-medium">{pct}% of this figure is split, not measured.</p>
          <p className="mt-1 text-xs">
            {money(cell.split)} was divided equally across the plan&apos;s targets
            because the product&apos;s own targets do not include them
            {cell.split_items.length ? ":" : "."}
          </p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {cell.split_items.map((code) => (
              <li key={code}>
                {nameOf(code)}{" "}
                <span className="font-mono opacity-60">{code}</span>
              </li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex min-h-svh w-full min-w-0 flex-col">
        <PageHeader
          eyebrow={
            view === "budget" ? (
              <>Chemical &amp; foliar expense by farm · ledger against budget</>
            ) : (
              <>Chemical &amp; foliar spend by greenhouse and target · all product consumed</>
            )
          }
          title={<>Finances</>}
          switcher={
            <Tabs value={view} onValueChange={(v) => setView(v as FinanceView)}>
              <TabsList>
                <TabsTrigger value="target">By target</TabsTrigger>
                <TabsTrigger value="budget">Budget</TabsTrigger>
              </TabsList>
            </Tabs>
          }
        >
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex items-center">
              <DateRangePicker
                label="Finance date range"
                value={{ from, to }}
                onChange={(r) => {
                  setFrom(r.from);
                  setTo(r.to);
                }}
              />
            </div>
          </div>
        </PageHeader>

        {view === "budget" ? (
          <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
            <BudgetView from={from} to={to} crop={initialCrop} />
          </div>
        ) : (
        <div
          className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 md:px-6 md:py-6"
          aria-busy={loading || pending || undefined}
        >
          <LoadProgress active={loading && !!data} />
          {(data || pending) && (
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>
                <span className="font-medium text-foreground">
                  Each unit of product is counted once, where it leaves the store for use:
                </span>{" "}
                transfers into the CSU against a work order, and issues straight from a
                store. A spray issued out of the CSU is not counted again, and loaning
                between farms, tank mixing and receipts are not spend. Values are the
                stock valuation at posting.
              </p>
            </div>
          )}

          {pending && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span>
                Total spend: <TextSkeleton width="10ch" />
              </span>
              <span>
                {from} → {to}
              </span>
            </div>
          )}

          {data && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span>
                Total spend:{" "}
                <span className="font-semibold text-foreground tabular-nums">
                  {money(data.grand_total)}
                </span>
              </span>
              {(["chemical", "foliar"] as const).map((k) =>
                data.totals_by_kind?.[k] ? (
                  <span key={k}>
                    {KIND_LABEL[k]}:{" "}
                    <span className="font-medium text-foreground tabular-nums">
                      {money(data.totals_by_kind[k])}
                    </span>
                  </span>
                ) : null,
              )}
              <span>
                {from} → {to}
              </span>
            </div>
          )}

          {pending ? (
            <FinanceSkeleton />
          ) : error ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-destructive">
                {error}
              </CardContent>
            </Card>
          ) : !data ||
            (!data.farms.length && !data.unattributed.length && !data.no_valuation.length) ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No product consumed in this period.
              </CardContent>
            </Card>
          ) : (
            <>
              {!!data.cost_per_target.length && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Target className="h-4 w-4 text-muted-foreground" />
                      Cost per target
                    </CardTitle>
                    <CardDescription>
                      What treating each pest and disease cost over the period, across
                      every greenhouse. Share is of all pest and disease spend; Nutrition
                      and unattributed spend are not in it.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="min-w-0 p-0">
                    <div className="overflow-x-auto">
                      <table aria-label="Cost per target" className="w-full text-sm border-collapse">
                        <thead className="text-[0.7rem] uppercase tracking-wide text-muted-foreground border-b">
                          <tr>
                            <th className="text-left px-3 py-2">Target</th>
                            <th className="text-left px-3 py-2">Kind</th>
                            <th className="text-right px-3 py-2">Spend</th>
                            <th className="text-right px-3 py-2">Share</th>
                            <th className="text-right px-3 py-2">Houses</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.cost_per_target.map((t) => {
                            const pct = (t.share * 100).toFixed(1);
                            return (
                              <tr key={t.target} className="border-b last:border-0 hover:bg-muted/40">
                                <td className="px-3 py-2 font-medium whitespace-nowrap">{t.target}</td>
                                <td className="px-3 py-2 text-xs text-muted-foreground capitalize">
                                  {t.kind}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                                  <Cell
                                    cell={{
                                      value: t.value,
                                      attributed: t.attributed,
                                      split: t.split,
                                      split_items: [],
                                    }}
                                  />
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                  <div className="flex items-center justify-end gap-2">
                                    <div className="hidden sm:block h-1.5 w-20 rounded-full bg-muted overflow-hidden">
                                      <div
                                        className="h-full rounded-full bg-foreground/60"
                                        style={{ width: `${Math.min(100, t.share * 100)}%` }}
                                      />
                                    </div>
                                    <span>{pct}%</span>
                                  </div>
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">{t.houses}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              )}

              {data.farms.map((farm) => (
                <Card key={farm.farm}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">{farm.farm}</CardTitle>
                    <CardDescription className="text-[0.7rem] tabular-nums">
                      {farm.rows.length} row{farm.rows.length === 1 ? "" : "s"} ·{" "}
                      {money(farm.total)} total
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="min-w-0 p-0">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm border-collapse">
                        <thead className="text-[0.7rem] uppercase tracking-wide text-muted-foreground border-b">
                          <tr>
                            <th className="sticky left-0 z-20 bg-card after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border text-left px-3 py-2">
                              Greenhouse
                            </th>
                            <th className="text-left px-3 py-2">Kind</th>
                            {farm.targets.map((t) => (
                              <th key={t} className="text-right px-3 py-2 whitespace-nowrap">
                                {t}
                              </th>
                            ))}
                            <th className="text-right px-3 py-2 font-semibold">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {farm.rows.map((r) => (
                            <tr
                              key={`${r.greenhouse}-${r.kind}`}
                              className="border-b last:border-0 hover:bg-muted/40"
                            >
                              <td className="sticky left-0 z-20 bg-card after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border px-3 py-2 font-medium whitespace-nowrap">
                                {r.greenhouse}
                              </td>
                              <td className="px-3 py-2 text-xs text-muted-foreground">
                                {KIND_LABEL[r.kind] || r.kind}
                              </td>
                              {farm.targets.map((t) => (
                                <td key={t} className="px-3 py-2 text-right tabular-nums">
                                  <Cell cell={r.costs[t]} />
                                </td>
                              ))}
                              <td className="px-3 py-2 text-right tabular-nums font-semibold">
                                {money(r.total)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="border-t-2">
                          <tr className="font-semibold">
                            <td className="sticky left-0 z-20 bg-card after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border px-3 py-2">Total</td>
                            <td />
                            {farm.targets.map((t) => (
                              <td key={t} className="px-3 py-2 text-right tabular-nums">
                                {money(farm.target_totals[t])}
                              </td>
                            ))}
                            <td className="px-3 py-2 text-right tabular-nums">
                              {money(farm.total)}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              ))}

              {!!data.unattributed.length && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <TriangleAlert className="h-4 w-4 text-amber-600 dark:text-amber-500" />
                      Unattributed spend
                    </CardTitle>
                    <CardDescription>
                      Issued without a work order (or against one with no pest or disease
                      recorded), so it carries no greenhouse and no target.{" "}
                      <span className="font-medium text-foreground tabular-nums">
                        {money(unattributedTotal)}
                      </span>{" "}
                      of {money(data.grand_total)}.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="p-0">
                    <table className="w-full text-sm border-collapse">
                      <thead className="text-[0.7rem] uppercase tracking-wide text-muted-foreground border-b">
                        <tr>
                          <th className="text-left px-3 py-2">Farm</th>
                          <th className="text-left px-3 py-2">Cost centre</th>
                          <th className="text-left px-3 py-2">Kind</th>
                          <th className="text-right px-3 py-2">Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.unattributed.map((u) => (
                          <tr
                            key={`${u.farm}-${u.cost_center}-${u.kind}`}
                            className="border-b last:border-0"
                          >
                            <td className="px-3 py-2 font-medium">{u.farm}</td>
                            <td className="px-3 py-2">{u.cost_center}</td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">
                              {KIND_LABEL[u.kind] || u.kind}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {money(u.value)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              )}

              {!!data.untargeted_items.length && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Split className="h-4 w-4 text-amber-600 dark:text-amber-500" />
                      Products with no targets recorded
                      <Badge variant="secondary">{data.untargeted_items.length}</Badge>
                    </CardTitle>
                    <CardDescription>
                      Their cost can only be split evenly across each plan&apos;s targets.
                      Recording targets on these products turns the split figures above
                      into measured ones — this list should shrink over time.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="max-h-80 overflow-y-auto">
                      <table className="w-full text-sm border-collapse">
                        <thead className="text-[0.7rem] uppercase tracking-wide text-muted-foreground border-b sticky top-0 bg-card">
                          <tr>
                            <th className="text-left px-3 py-2">Item</th>
                            <th className="text-left px-3 py-2">Kind</th>
                            <th className="text-right px-3 py-2">Spend</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.untargeted_items.map((u) => (
                            <tr key={u.item_code} className="border-b last:border-0">
                              <td className="px-3 py-2">
                                <span className="font-medium">{u.item_name}</span>{" "}
                                <span className="text-xs text-muted-foreground font-mono">
                                  {u.item_code}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-xs text-muted-foreground">
                                {KIND_LABEL[u.kind] || u.kind}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {money(u.value)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              )}
              {!!data.no_valuation.length && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <CircleSlash className="h-4 w-4 text-amber-600 dark:text-amber-500" />
                      No valuation
                      <Badge variant="secondary">{data.no_valuation.length}</Badge>
                    </CardTitle>
                    <CardDescription>
                      Product that left the store at a valuation of zero. It is counted as
                      nothing above, so the real cost is missing until the stock is valued.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="min-w-0 p-0">
                    <div className="max-h-80 overflow-auto">
                      <table className="w-full text-sm border-collapse">
                        <thead className="text-[0.7rem] uppercase tracking-wide text-muted-foreground border-b sticky top-0 bg-card">
                          <tr>
                            <th className="text-left px-3 py-2">Date</th>
                            <th className="text-left px-3 py-2">Stock entry</th>
                            <th className="text-left px-3 py-2">Item</th>
                            <th className="text-left px-3 py-2">Greenhouse</th>
                            <th className="text-right px-3 py-2">Qty</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.no_valuation.map((n, i) => (
                            <tr key={`${n.stock_entry}-${n.item_code}-${i}`} className="border-b last:border-0">
                              <td className="px-3 py-2 tabular-nums whitespace-nowrap">{n.posting_date}</td>
                              <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{n.stock_entry}</td>
                              <td className="px-3 py-2">
                                <span className="font-medium">{n.item_name}</span>{" "}
                                <span className="text-xs text-muted-foreground font-mono">{n.item_code}</span>
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap">{n.greenhouse || n.farm}</td>
                              <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                                {n.qty} {n.uom || ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
        )}
      </div>
    </TooltipProvider>
  );
}

/** The report's first two cards before any figures: their titles and column
 *  headings are real, the rows (and the farm's name) pending. */
function FinanceSkeleton() {
  const head = "text-[0.7rem] uppercase tracking-wide text-muted-foreground border-b";
  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="h-4 w-4 text-muted-foreground" />
            Cost per target
          </CardTitle>
          <CardDescription>
            What treating each pest and disease cost over the period, across
            every greenhouse. Share is of all pest and disease spend; Nutrition
            and unattributed spend are not in it.
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 p-0">
          <Table aria-label="Cost per target" className="text-sm">
            <thead className={head}>
              <tr>
                <th className="text-left px-3 py-2">Target</th>
                <th className="text-left px-3 py-2">Kind</th>
                <th className="text-right px-3 py-2">Spend</th>
                <th className="text-right px-3 py-2">Share</th>
                <th className="text-right px-3 py-2">Houses</th>
              </tr>
            </thead>
            <TableBody>
              <TableRowsSkeleton cols={5} rows={5} />
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            <TextSkeleton width="10ch" />
          </CardTitle>
          <CardDescription className="text-[0.7rem]">
            <TextSkeleton width="16ch" />
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 p-0">
          <Table className="text-sm">
            <thead className={head}>
              <tr>
                <th className="text-left px-3 py-2">Greenhouse</th>
                <th className="text-left px-3 py-2">Kind</th>
                <th className="text-right px-3 py-2" aria-hidden>
                  <TextSkeleton width="8ch" />
                </th>
                <th className="text-right px-3 py-2" aria-hidden>
                  <TextSkeleton width="8ch" />
                </th>
                <th className="text-right px-3 py-2 font-semibold">Total</th>
              </tr>
            </thead>
            <TableBody>
              <TableRowsSkeleton cols={5} rows={6} />
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
