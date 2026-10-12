/**
 * Finance, Budget view (B7): what the ledger says each farm spent on chemicals
 * and foliars, against its ERPNext Budget and the procurement cycles approved
 * for the period — and the reconciling line back to the stock-based report.
 *
 * Backend: upande_scp.serverscripts.reports.finance_budget.budget_vs_actual
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { Building2, Info, Landmark, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Table, TableBody } from "@/components/ui/table";
import { LoadProgress, TableRowsSkeleton, TextSkeleton } from "@/components/Loading";
import {
  fetchBudgetVsActual,
  type BudgetFigures,
  type BudgetReport,
} from "@/lib/finance-api";

const KIND_LABEL: Record<string, string> = { chemical: "Chemicals", foliar: "Foliars" };

const HEADS = [
  "Farm",
  "Cost centre",
  "Actual (ledger)",
  "Budget",
  "Draft budget",
  "Approved cycles",
  "Stock based",
  "Reconciling",
];

export function BudgetView({
  from,
  to,
  crop,
}: {
  from: string;
  to: string;
  crop?: string;
}) {
  const [data, setData] = useState<BudgetReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchBudgetVsActual(from, to, crop ? { crop } : {})
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e?.message || "Failed to load the budget view"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [from, to, crop]);

  const money = useMemo(() => {
    const cur = data?.currency || "KES";
    const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
    return (n: number | null | undefined) =>
      n === null || n === undefined ? "—" : n ? `${cur} ${fmt.format(Math.round(n))}` : "—";
  }, [data?.currency]);

  const years = useMemo(
    () => [...new Set(Object.values(data?.fiscal_years || {}).flat())].join(", "),
    [data],
  );

  const pending = !data && !error;

  function Figures({ f, strong }: { f: BudgetFigures; strong?: boolean }) {
    const over = f.actual !== null && f.budget > 0 && f.actual > f.budget;
    return (
      <>
        <td
          className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${strong ? "font-semibold" : ""} ${
            over ? "text-amber-700 dark:text-amber-500" : ""
          }`}
        >
          {over && (
            <TriangleAlert
              aria-label="Over budget"
              className="mr-1 inline h-3.5 w-3.5 align-[-2px]"
            />
          )}
          {money(f.actual)}
        </td>
        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{money(f.budget)}</td>
        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-muted-foreground">
          {money(f.draft_budget)}
        </td>
        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{money(f.approved)}</td>
        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{money(f.stock_based)}</td>
        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{money(f.reconciling)}</td>
      </>
    );
  }

  const head = "text-[0.7rem] uppercase tracking-wide text-muted-foreground border-b";

  return (
    <div className="flex min-w-0 flex-col gap-4" aria-busy={loading || pending || undefined}>
      <LoadProgress active={loading && !!data} />
      <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          <span className="font-medium text-foreground">
            Actual is the ledger, read per farm cost-centre tree:
          </span>{" "}
          the chemical and foliar expense accounts, as ERPNext&apos;s budget variance report sums
          them. Budget is the submitted ERPNext Budget for the fiscal year
          {years ? ` (${years})` : ""}, an annual figure. The reconciling line is stock based
          minus actual — mostly product moved into a CSU but not yet sprayed, which the stock
          report counts on the transfer and the ledger only on the spray.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        {(
          [
            ["Actual", data?.totals.actual],
            ["Budget", data?.totals.budget],
            ["Approved cycles", data?.totals.approved],
            ["Stock based", data?.totals.stock_based],
            ["Reconciling", data?.totals.reconciling],
          ] as const
        ).map(([label, v]) => (
          <span key={label}>
            {label}:{" "}
            {pending ? (
              <TextSkeleton width="9ch" />
            ) : (
              <span className="font-semibold text-foreground tabular-nums">{money(v ?? 0)}</span>
            )}
          </span>
        ))}
      </div>

      {error ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Landmark className="h-4 w-4 text-muted-foreground" />
              Actual against budget, by farm
            </CardTitle>
            <CardDescription>
              Approved cycles are the procurement cycles whose period overlaps this one, valued
              at the rate they were ordered at.
            </CardDescription>
          </CardHeader>
          <CardContent className="min-w-0 p-0">
            <div className="overflow-x-auto">
              <Table aria-label="Actual against budget" className="text-sm">
                <thead className={head}>
                  <tr>
                    {HEADS.map((h, i) => (
                      <th
                        key={h}
                        className={`px-3 py-2 whitespace-nowrap ${i < 2 ? "text-left" : "text-right"} ${
                          i === 0
                            ? "sticky left-0 z-20 bg-card after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border"
                            : ""
                        }`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <TableBody>
                  {pending && <TableRowsSkeleton cols={HEADS.length} rows={5} />}
                  {data && !data.farms.length && (
                    <tr>
                      <td colSpan={HEADS.length} className="py-8 text-center text-muted-foreground">
                        No farms in view.
                      </td>
                    </tr>
                  )}
                  {data?.farms.map((f) => (
                    <Fragment key={f.farm}>
                      <tr className="border-t hover:bg-muted/40">
                        <td className="sticky left-0 z-20 bg-card after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border px-3 py-2 font-medium whitespace-nowrap">
                          {f.farm}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-xs">
                          {f.mapped ? (
                            f.cost_center
                          ) : (
                            <Badge variant="secondary">No cost centre</Badge>
                          )}
                        </td>
                        <Figures f={f} strong />
                      </tr>
                      {(["chemical", "foliar"] as const).map((k) => (
                        <tr key={k} className="text-xs text-muted-foreground">
                          <td className="sticky left-0 z-20 bg-card after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border px-3 py-1 pl-6 whitespace-nowrap">
                            {KIND_LABEL[k]}
                          </td>
                          <td />
                          <Figures f={f.kinds[k]} />
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {!!data?.outside.length && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="h-4 w-4 text-amber-600 dark:text-amber-500" />
              Booked outside the farms
            </CardTitle>
            <CardDescription>
              Chemical and foliar expense on cost centres under no farm&apos;s tree, so it is in
              no farm&apos;s actual above.{" "}
              <span className="font-medium text-foreground tabular-nums">
                {money(data.outside_total)}
              </span>{" "}
              in the period. Moving these cost centres is for Accounts to decide.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-80 overflow-y-auto">
              <table aria-label="Booked outside the farms" className="w-full text-sm border-collapse">
                <thead className={`${head} sticky top-0 bg-card`}>
                  <tr>
                    <th className="text-left px-3 py-2">Cost centre</th>
                    <th className="text-left px-3 py-2">Kind</th>
                    <th className="text-right px-3 py-2">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.outside.map((o) => (
                    <tr key={`${o.company}-${o.cost_center}-${o.kind}`} className="border-b last:border-0">
                      <td className="px-3 py-2 font-medium">{o.cost_center}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {KIND_LABEL[o.kind] || o.kind}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(o.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {!!data?.notes.length && (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {data.notes.map((n) => (
            <li key={n} className="flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
              {n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
