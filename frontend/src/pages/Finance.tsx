/**
 * Finances - crop-protection spend (the actual stock-ledger value of product
 * consumed) by pest / disease, product, greenhouse and period.
 *
 * Each product's cost on a plan is attributed to the plan's targets that the
 * product is registered for, split evenly. Cost no target claims is shown as
 * Unattributed - explicitly, as its own line - so the target figures plus the
 * unattributed line always equal the total spend. See serverscripts/reports/finances.py.
 */
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { CircleCheck, Info, Leaf, TriangleAlert } from "lucide-react";
import { DatePicker } from "@/components/DatePicker";
import { FilterSelect } from "@/components/FilterSelect";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadProgress, TableRowsSkeleton } from "@/components/Loading";
import { Table, TableBody } from "@/components/ui/table";
import {
  fetchChemicalCostByTarget,
  fetchSuggestedRegistrations,
  registerProductTargets,
  type AllocationBasis,
  type ChemicalCostReport,
  type SuggestedRegistration,
  type UnattributedReason,
} from "@/lib/finance-api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { bootstrap } from "@/lib/frappe";
import { ymd } from "@/lib/utils";

function monthStart(): string {
  const d = new Date();
  return ymd(new Date(d.getFullYear(), d.getMonth(), 1));
}

const KIND_LABEL: Record<string, string> = { chemical: "Chemicals", foliar: "Foliars" };
const REASON_LABEL: Record<UnattributedReason, string> = {
  no_plan: "Issued with no plan or no targets",
};
const BASIS_LABEL: Record<AllocationBasis, string> = {
  registered: "Registered for the target",
  ai_class: "Active-ingredient class (IRAC / FRAC)",
  history: "Usage history (180 days)",
  nutrition: "Crop nutrition & adjuvants",
  equal: "Equal split",
  unattributed: "Unattributed",
};
const BASIS_HINT: Record<AllocationBasis, string> = {
  registered: "the product is registered for a target on the plan",
  ai_class: "its mode-of-action class fits only some of the plan's targets",
  history: "split by where the product has been used, from the last 180 days of plans",
  nutrition: "foliars, adjuvants and pH buffers are not crop protection",
  equal: "nothing else is known, so shared equally across the plan's targets",
  unattributed: "issued with no plan or no targets",
};
/** Roles that may write registrations (matches the server's GM / System Manager gate). */
const CAN_REGISTER = ["General Manager", "SCP General Manager", "System Manager", "Administrator"];
/** Bounded scroll box for long tables: the page itself never grows with the data. */
const BOX = "max-h-[28rem] overflow-auto";

/** Horizontal share bar; the unattributed portion is drawn muted beside it. */
function ShareBar({ part, total, muted }: { part: number; total: number; muted?: boolean }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (part / total) * 100)) : 0;
  return (
    <div className="h-2 w-full min-w-24 rounded-full bg-muted" aria-hidden>
      <div
        className={`h-2 rounded-full ${muted ? "bg-muted-foreground/40" : "bg-primary"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

const TH = "sticky top-0 z-10 bg-card text-[0.7rem] uppercase tracking-wide text-muted-foreground border-b";

export function Finance({ initialCrop }: { initialCrop?: string } = {}) {
  const [from, setFrom] = useState<string>(monthStart);
  const [to, setTo] = useState<string>(() => ymd(new Date()));
  const [farm, setFarm] = useState("");
  const [data, setData] = useState<ChemicalCostReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchChemicalCostByTarget(from, to, { farm, crop: initialCrop })
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e?.message || "Failed to load finances"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [from, to, farm, initialCrop]);

  const money = useMemo(() => {
    const cur = data?.currency || "KES";
    const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
    return (n: number) => (n ? `${cur} ${fmt.format(Math.round(n))}` : "-");
  }, [data?.currency]);
  const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;

  const canRegister = (bootstrap().roles || []).some((r: string) => CAN_REGISTER.includes(r));
  const [suggested, setSuggested] = useState<SuggestedRegistration[]>([]);
  const [pending, setPending] = useState<SuggestedRegistration | null>(null);
  const [registering, setRegistering] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);
  const loadSuggested = () =>
    fetchSuggestedRegistrations()
      .then(setSuggested)
      .catch(() => setSuggested([]));
  useEffect(() => {
    if (canRegister) void loadSuggested();
  }, [canRegister]);

  async function confirmRegister() {
    if (!pending) return;
    setRegistering(true);
    setRegError(null);
    try {
      await registerProductTargets(pending.product, pending.suggestions.map((x) => x.target));
      setPending(null);
      void loadSuggested();
    } catch (e) {
      setRegError(e instanceof Error ? e.message : "Could not register");
    } finally {
      setRegistering(false);
    }
  }

  // Farm options come from the unfiltered view the first time it loads.
  const [farmOptions, setFarmOptions] = useState<string[]>([]);
  useEffect(() => {
    if (data && !farm) setFarmOptions([...new Set(data.by_place.map((p) => p.farm))].sort());
  }, [data, farm]);

  const unattributedByReason = useMemo(() => {
    const out: Record<string, number> = {};
    for (const u of data?.unattributed || []) out[u.reason] = (out[u.reason] || 0) + u.value;
    return out;
  }, [data]);

  const total = data?.grand_total || 0;
  const hasData = !!data && total > 0;
  const periodMax = Math.max(0, ...(data?.by_period || []).map((p) => p.value));
  const empty = !loading && !error && !hasData;

  return (
    <div className="flex min-h-svh w-full min-w-0 flex-col">
      <PageHeader
        eyebrow={<>Crop-protection spend, stock-ledger actuals, by pest and disease</>}
        title={<>Finances</>}
      />
      {/* Filters stay pinned while the report scrolls beneath. */}
      <div className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b bg-background/95 px-4 py-2 backdrop-blur md:px-6">
        <DatePicker value={from} onChange={setFrom} />
        <DatePicker value={to} onChange={setTo} />
        <FilterSelect
          label="Farm"
          value={farm}
          onChange={setFarm}
          options={farmOptions}
          allLabel="All farms"
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
        <LoadProgress active={loading} label="Reading the stock ledger" />

        {error ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-destructive">{error}</CardContent>
          </Card>
        ) : null}

        {data && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="pb-1">
                <CardDescription>Total spend</CardDescription>
                <CardTitle className="text-xl tabular-nums">{money(data.grand_total)}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                {(["chemical", "foliar"] as const)
                  .filter((k) => data.totals_by_kind?.[k])
                  .map((k) => `${KIND_LABEL[k]} ${money(data.totals_by_kind[k])}`)
                  .join(" · ") || "-"}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardDescription>Attributed to a pest or disease</CardDescription>
                <CardTitle className="text-xl tabular-nums">{money(data.attributed_total)}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                {pct(total ? data.attributed_total / total : 0)} of spend
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardDescription className="flex items-center gap-1.5">
                  <TriangleAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-500" />
                  Unattributed
                </CardDescription>
                <CardTitle className="text-xl tabular-nums">{money(data.unattributed_total)}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                {pct(data.unattributed_share)} of spend
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardDescription className="flex items-center gap-1.5">
                  <CircleCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-500" />
                  Reconciles
                </CardDescription>
                <CardTitle className="text-xl tabular-nums">
                  {Math.abs(data.reconciliation.difference) < 0.05 ? "To the cent" : money(data.reconciliation.difference)}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                targets + unattributed = total
                {data.ledger_fallback_lines ? ` · ${data.ledger_fallback_lines} lines priced from the entry, not the ledger` : ""}
              </CardContent>
            </Card>
          </div>
        )}

        {loading && !data ? (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableBody>
                  <TableRowsSkeleton rows={6} cols={4} />
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : null}

        {empty && data ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No product consumed in this period.
            </CardContent>
          </Card>
        ) : null}

        {hasData && data && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">How the spend was assigned</CardTitle>
              <CardDescription>
                Each product line goes to the first rule that applies. Shares always add up to the total.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {data.by_basis.map((b) => (
                <div key={b.basis} className="min-w-0" title={BASIS_HINT[b.basis]}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="truncate">{BASIS_LABEL[b.basis]}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {money(b.value)} · {pct(b.share)}
                    </span>
                  </div>
                  <ShareBar part={b.value} total={total} muted={b.basis === "unattributed"} />
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {hasData && data && (
          <Tabs defaultValue="target" className="flex flex-col gap-4">
            <TabsList className="self-start">
              <TabsTrigger value="target">By pest / disease</TabsTrigger>
              <TabsTrigger value="product">By product</TabsTrigger>
              <TabsTrigger value="place">By greenhouse</TabsTrigger>
              <TabsTrigger value="period">By {data.granularity}</TabsTrigger>
            </TabsList>

            <TabsContent value="target" className="mt-0 flex flex-col gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Spend by pest and disease</CardTitle>
                  <CardDescription className="flex items-start gap-1.5">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    A product&apos;s cost on a plan is shared evenly across the plan&apos;s targets
                    that the product is registered for. Cost no target claims is the Unattributed line.
                  </CardDescription>
                </CardHeader>
                <CardContent className={`${BOX} p-0`}>
                  <table className="w-full border-collapse text-sm">
                    <thead className={TH}>
                      <tr>
                        <th className="px-3 py-2 text-left">Pest / disease</th>
                        <th className="w-1/3 px-3 py-2 text-left">Share of spend</th>
                        <th className="px-3 py-2 text-right">Houses</th>
                        <th className="px-3 py-2 text-right">Spend</th>
                        <th className="px-3 py-2 text-right">%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.cost_per_target.map((t) => (
                        <tr key={t.target} className="border-b hover:bg-muted/40">
                          <td className="px-3 py-2 align-top">
                            <div className="flex items-center gap-1.5 font-medium">
                              {t.kind === "nutrition" ? <Leaf className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-500" /> : null}
                              {t.target}
                              {t.kind === "pest" || t.kind === "disease" ? (
                                <span className="text-[0.65rem] font-normal uppercase tracking-wide text-muted-foreground">{t.kind}</span>
                              ) : null}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {(Object.entries(t.basis) as [AllocationBasis, number][])
                                .sort((x, y) => y[1] - x[1])
                                .map(([bk, v]) => `${BASIS_LABEL[bk].split(" (")[0].toLowerCase()} ${money(v)}`)
                                .join(" · ")}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {t.products
                                .slice(0, 3)
                                .map((p) => `${p.item_name} ${money(p.value)}`)
                                .join(" · ")}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <ShareBar part={t.value} total={total} />
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{t.houses}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(t.value)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{pct(t.share)}</td>
                        </tr>
                      ))}
                      <tr className="border-b bg-muted/30">
                        <td className="px-3 py-2 align-top">
                          <div className="flex items-center gap-1.5 font-medium">
                            <TriangleAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-500" />
                            Unattributed
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {(Object.keys(unattributedByReason) as UnattributedReason[])
                              .map((r) => `${REASON_LABEL[r]}: ${money(unattributedByReason[r])}`)
                              .join(" · ")}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <ShareBar part={data.unattributed_total} total={total} muted />
                        </td>
                        <td className="px-3 py-2" />
                        <td className="px-3 py-2 text-right tabular-nums">{money(data.unattributed_total)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{pct(data.unattributed_share)}</td>
                      </tr>
                    </tbody>
                    <tfoot>
                      <tr className="font-semibold">
                        <td className="px-3 py-2">Total spend</td>
                        <td />
                        <td />
                        <td className="px-3 py-2 text-right tabular-nums">{money(total)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">100%</td>
                      </tr>
                    </tfoot>
                  </table>
                </CardContent>
              </Card>

              {data.farms.map((f) => (
                <Card key={f.farm}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">{f.farm}: greenhouse by target</CardTitle>
                    <CardDescription className="tabular-nums">
                      {money(f.total)} attributed. Each greenhouse&apos;s remainder is on the greenhouse tab.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className={`${BOX} p-0`}>
                    <table className="w-full border-collapse text-sm">
                      <thead className={TH}>
                        <tr>
                          <th className="px-3 py-2 text-left">Greenhouse</th>
                          <th className="px-3 py-2 text-left">Kind</th>
                          {f.targets.map((t) => (
                            <th key={t} className="whitespace-nowrap px-3 py-2 text-right">{t}</th>
                          ))}
                          <th className="px-3 py-2 text-right font-semibold">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {f.rows.map((r) => (
                          <tr key={`${r.greenhouse}-${r.kind}`} className="border-b last:border-0 hover:bg-muted/40">
                            <td className="whitespace-nowrap px-3 py-2 font-medium">{r.greenhouse}</td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">{KIND_LABEL[r.kind] || r.kind}</td>
                            {f.targets.map((t) => (
                              <td key={t} className="px-3 py-2 text-right tabular-nums">
                                {r.costs[t] ? money(r.costs[t]) : <span className="text-muted-foreground/40">-</span>}
                              </td>
                            ))}
                            <td className="px-3 py-2 text-right font-semibold tabular-nums">{money(r.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              ))}
            </TabsContent>

            <TabsContent value="product" className="mt-0">
              <Card>
                <CardContent className={`${BOX} p-0`}>
                  <table className="w-full border-collapse text-sm">
                    <thead className={TH}>
                      <tr>
                        <th className="px-3 py-2 text-left">Product</th>
                        <th className="px-3 py-2 text-left">Kind</th>
                        <th className="px-3 py-2 text-left">Attributed to</th>
                        <th className="px-3 py-2 text-right">Unattributed</th>
                        <th className="px-3 py-2 text-right">Spend</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.by_product.map((p) => (
                        <tr key={p.item_code} className="border-b last:border-0 hover:bg-muted/40">
                          <td className="px-3 py-2">
                            <span className="font-medium">{p.item_name}</span>{" "}
                            <span className="font-mono text-xs text-muted-foreground">{p.item_code}</span>
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">{KIND_LABEL[p.kind] || p.kind}</td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {p.targets.map((t) => `${t.target} ${money(t.value)}`).join(" · ") || "-"}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(p.unattributed)}</td>
                          <td className="px-3 py-2 text-right font-medium tabular-nums">{money(p.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="place" className="mt-0">
              <Card>
                <CardContent className={`${BOX} p-0`}>
                  <table className="w-full border-collapse text-sm">
                    <thead className={TH}>
                      <tr>
                        <th className="px-3 py-2 text-left">Farm</th>
                        <th className="px-3 py-2 text-left">Greenhouse</th>
                        <th className="w-1/4 px-3 py-2 text-left">Share of spend</th>
                        <th className="px-3 py-2 text-right">Attributed</th>
                        <th className="px-3 py-2 text-right">Unattributed</th>
                        <th className="px-3 py-2 text-right">Spend</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.by_place.map((p) => (
                        <tr key={`${p.farm}-${p.greenhouse}`} className="border-b last:border-0 hover:bg-muted/40">
                          <td className="px-3 py-2 text-xs text-muted-foreground">{p.farm}</td>
                          <td className="whitespace-nowrap px-3 py-2 font-medium">{p.greenhouse}</td>
                          <td className="px-3 py-2"><ShareBar part={p.value} total={total} /></td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(p.attributed)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(p.unattributed)}</td>
                          <td className="px-3 py-2 text-right font-medium tabular-nums">{money(p.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="period" className="mt-0">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    Spend per {data.granularity === "week" ? "week (starting Monday)" : "month"}
                  </CardTitle>
                </CardHeader>
                <CardContent className={`${BOX} p-0`}>
                  <table className="w-full border-collapse text-sm">
                    <thead className={TH}>
                      <tr>
                        <th className="px-3 py-2 text-left">{data.granularity === "week" ? "Week of" : "Month"}</th>
                        <th className="w-1/3 px-3 py-2 text-left">Spend</th>
                        <th className="px-3 py-2 text-right">Attributed</th>
                        <th className="px-3 py-2 text-right">Unattributed</th>
                        <th className="px-3 py-2 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.by_period.map((p) => (
                        <tr key={p.period} className="border-b last:border-0 hover:bg-muted/40">
                          <td className="whitespace-nowrap px-3 py-2 font-medium">{p.period}</td>
                          <td className="px-3 py-2"><ShareBar part={p.value} total={periodMax} /></td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(p.attributed)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(p.unattributed)}</td>
                          <td className="px-3 py-2 text-right font-medium tabular-nums">{money(p.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        )}

        {canRegister && suggested.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Suggested pest registrations</CardTitle>
              <CardDescription>
                Products with no registered targets, and where the last 180 days of plans used them (at least 3
                plans, 30% or more of use). Registering makes their cost attribute by registration.
              </CardDescription>
            </CardHeader>
            <CardContent className={`${BOX} p-0`}>
              <table className="w-full border-collapse text-sm">
                <thead className={TH}>
                  <tr>
                    <th className="px-3 py-2 text-left">Product</th>
                    <th className="px-3 py-2 text-right">Plans</th>
                    <th className="px-3 py-2 text-left">Suggested targets</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {suggested.map((x) => (
                    <tr key={x.product} className="border-b last:border-0">
                      <td className="px-3 py-2 font-medium">{x.product_name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{x.plans}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {x.suggestions.map((g) => `${g.target} ${pct(g.share)}`).join(" · ")}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button size="sm" variant="outline" onClick={() => { setRegError(null); setPending(x); }}>
                          Register
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        <Dialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Register targets for {pending?.product_name}?</DialogTitle>
              <DialogDescription>
                This adds {pending?.suggestions.map((g) => g.target).join(", ")} to the product&apos;s registered
                targets. The spray check will then treat it as registered for them.
              </DialogDescription>
            </DialogHeader>
            {regError ? <p className="text-sm text-destructive">{regError}</p> : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setPending(null)} disabled={registering}>
                Cancel
              </Button>
              <Button onClick={() => void confirmRegister()} disabled={registering}>
                Register
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {data && data.no_valuation.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <TriangleAlert className="h-4 w-4 text-amber-600 dark:text-amber-500" />
                Consumed with no value ({data.no_valuation.length} lines)
              </CardTitle>
              <CardDescription>
                These lines have no valuation in the stock ledger, so they count as zero above.
              </CardDescription>
            </CardHeader>
            <CardContent className={`${BOX} p-0`}>
              <table className="w-full border-collapse text-sm">
                <tbody>
                  {data.no_valuation.slice(0, 100).map((l, i) => (
                    <tr key={`${l.stock_entry}-${l.item_code}-${i}`} className="border-b last:border-0">
                      <td className="px-3 py-2">{l.item_name}</td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{l.stock_entry}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{l.posting_date}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{l.qty} {l.uom}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
