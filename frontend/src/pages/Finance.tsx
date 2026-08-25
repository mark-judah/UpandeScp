/**
 * Finances — crop-protection spend per greenhouse, broken down by the
 * pest/disease it was spent on, over a chosen period.
 *
 * Cost is the ACTUAL value of product consumed: submitted Material Transfer for
 * Manufacture AND Material Issue line amounts. See serverscripts/finances.py.
 *
 * Two things this page must never hide:
 *   - a SPLIT figure, divided equally across a plan's targets because the
 *     product records none, is not a measurement and is marked as such;
 *   - spend issued straight from the store has no greenhouse and no target, and
 *     is reported as unattributed rather than given a home it never had.
 */
import { useEffect, useMemo, useState } from "react";
import { Coins, Info, Loader2, Split, TriangleAlert } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DatePicker } from "@/components/DatePicker";
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
import { ymd } from "@/lib/utils";

function monthStart(): string {
  const d = new Date();
  return ymd(new Date(d.getFullYear(), d.getMonth(), 1));
}

const KIND_LABEL: Record<string, string> = {
  chemical: "Chemicals",
  foliar: "Foliars",
};

export function Finance() {
  const [from, setFrom] = useState<string>(monthStart);
  const [to, setTo] = useState<string>(() => ymd(new Date()));
  const [data, setData] = useState<ChemicalCostReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchChemicalCostByTarget(from, to)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e?.message || "Failed to load finances"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [from, to]);

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
            {money(cell.split)} was divided equally across this plan&apos;s targets
            because these products have no targets recorded:
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
      <div className="flex min-h-svh w-full min-w-0 flex-col overflow-x-hidden">
        <header className="sticky top-0 z-20 flex flex-wrap items-end justify-between gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-6" />
            <div>
              <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight flex items-center gap-2">
                <Coins className="h-4 w-4" /> Finances
              </h1>
              <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
                Chemical &amp; foliar spend by greenhouse and target · all product consumed
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label>From</Label>
              <DatePicker value={from} onChange={setFrom} />
            </div>
            <div className="flex flex-col gap-1">
              <Label>To</Label>
              <DatePicker value={to} onChange={setTo} />
            </div>
          </div>
        </header>

        <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
          {data && (
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>
                <span className="font-medium text-foreground">
                  These totals now include product issued directly from the store.
                </span>{" "}
                This report previously counted only tank mixes moved against a work
                order — about a quarter of what is actually consumed, and almost no
                foliar at all. Figures are higher than before because the definition
                changed, not because the data did.
              </p>
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

          {loading ? (
            <Card>
              <CardContent className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
              </CardContent>
            </Card>
          ) : error ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-destructive">
                {error}
              </CardContent>
            </Card>
          ) : !data || (!data.farms.length && !data.unattributed.length) ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No product consumed in this period.
              </CardContent>
            </Card>
          ) : (
            <>
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
                      Issued directly from the store without a work order, so it carries
                      no greenhouse and no target.{" "}
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
                          <th className="text-left px-3 py-2">Cost centre</th>
                          <th className="text-left px-3 py-2">Kind</th>
                          <th className="text-right px-3 py-2">Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.unattributed.map((u) => (
                          <tr
                            key={`${u.cost_center}-${u.kind}`}
                            className="border-b last:border-0"
                          >
                            <td className="px-3 py-2 font-medium">{u.cost_center}</td>
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
            </>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
