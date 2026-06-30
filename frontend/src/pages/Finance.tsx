/**
 * Finances — chemical spend per greenhouse, broken down by the pest/disease it
 * was spent on, over a chosen period.
 *
 * Cost is the ACTUAL value of chemicals moved from the store to WIP/CSU
 * (submitted Material Transfer for Manufacture line amounts), attributed to the
 * pest(s)/disease(s) each chemical treats — not the work-order plan. See
 * serverscripts/finances.py.
 */
import { useEffect, useMemo, useState } from "react";
import { Coins, Loader2 } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/DatePicker";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { fetchChemicalCostByTarget, type ChemicalCostReport } from "@/lib/finance-api";
import { ymd } from "@/lib/utils";

function monthStart(): string {
  const d = new Date();
  return ymd(new Date(d.getFullYear(), d.getMonth(), 1));
}

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
    const fmt = new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 0,
    });
    return (n: number) => (n ? `${cur} ${fmt.format(Math.round(n))}` : "—");
  }, [data?.currency]);

  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-20 flex flex-wrap items-end justify-between gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-6" />
          <div>
            <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight flex items-center gap-2">
              <Coins className="h-4 w-4" /> Finances
            </h1>
            <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
              Chemical spend by greenhouse &amp; target · actual chemicals moved
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

      <div className="flex-1 px-4 md:px-6 py-4 md:py-6 flex flex-col gap-4">
        {data && (
          <div className="text-sm text-muted-foreground">
            Total chemical spend:{" "}
            <span className="font-semibold text-foreground tabular-nums">
              {money(data.grand_total)}
            </span>{" "}
            · {from} → {to}
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
        ) : !data || !data.farms.length ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No chemical movements in this period.
            </CardContent>
          </Card>
        ) : (
          data.farms.map((farm) => (
            <Card key={farm.farm}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{farm.farm}</CardTitle>
                <CardDescription className="text-[0.7rem] tabular-nums">
                  {farm.rows.length} greenhouse{farm.rows.length === 1 ? "" : "s"} ·{" "}
                  {money(farm.total)} total
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead className="text-[0.7rem] uppercase tracking-wide text-muted-foreground border-b">
                      <tr>
                        <th className="text-left px-3 py-2 sticky left-0 bg-card">
                          Greenhouse
                        </th>
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
                        <tr key={r.greenhouse} className="border-b last:border-0 hover:bg-muted/40">
                          <td className="px-3 py-2 sticky left-0 bg-card font-medium whitespace-nowrap">
                            {r.greenhouse}
                          </td>
                          {farm.targets.map((t) => (
                            <td
                              key={t}
                              className={
                                "px-3 py-2 text-right tabular-nums " +
                                (r.costs[t] ? "" : "text-muted-foreground/40")
                              }
                            >
                              {r.costs[t] ? money(r.costs[t]) : "—"}
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
                        <td className="px-3 py-2 sticky left-0 bg-card">Total</td>
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
          ))
        )}
      </div>
    </div>
  );
}
