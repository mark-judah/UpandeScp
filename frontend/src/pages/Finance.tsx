/**
 * Finances - crop-protection spend by pest and disease, through two tunnels.
 *
 *  - Through spray plans: only plans that went through to the end (Manufacture + the
 *    tank mix issued to a greenhouse). Spend is the stock-ledger value of the chemicals
 *    consumed; the greenhouse is the one the mix was issued to.
 *  - Direct material issues: issued with no plan, so no greenhouse (shown at farm level).
 *
 * Every figure carries its credibility: RECORDED (declared on the plan, solid) or
 * DERIVED (an estimate, hatched, with its backtested accuracy). Non-pest inputs are
 * reported apart from chemical pest cost, never added into it. See
 * serverscripts/reports/finance_paths.py.
 */
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { CircleCheck, Download, Info, Leaf, TriangleAlert } from "lucide-react";
import { DatePicker } from "@/components/DatePicker";
import { FilterSelect } from "@/components/FilterSelect";
import { MultiFilterSelect } from "@/components/MultiFilterSelect";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { LoadProgress, TableRowsSkeleton } from "@/components/Loading";
import { Table, TableBody } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  credibilityLabel,
  fetchPestAttribution,
  fetchSuggestedRegistrations,
  pestAttributionExportUrl,
  registerProductTargets,
  setCostGroup,
  COST_GROUPS,
  type PathBlock,
  type PathFilter,
  type PathKey,
  type PestAttributionReport,
  type SuggestedRegistration,
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
import { formatAmount } from "@/lib/number-format";

/** The page's one amount formatter: thousands separators, 2 decimals, no currency. */
const money = formatAmount;

function monthStart(): string {
  const d = new Date();
  return ymd(new Date(d.getFullYear(), d.getMonth(), 1));
}

const PATH_OPTIONS: Record<string, PathFilter> = {
  "Spray plan": "spray",
  "Direct issue": "direct",
  Both: "both",
};
const PATH_TITLE: Record<PathKey, string> = {
  spray: "Through spray plans",
  direct: "Direct material issues",
};
/** Roles that may write registrations (matches the server's GM / System Manager gate). */
const CAN_REGISTER = ["General Manager", "SCP General Manager", "System Manager", "Administrator"];
/** Bounded scroll box for long tables: the page itself never grows with the data. */
const BOX = "max-h-[28rem] overflow-auto";
const TH = "sticky top-0 z-10 bg-card text-[0.7rem] uppercase tracking-wide text-muted-foreground border-b";
/** Hatched fill: how a DERIVED (estimated) amount is drawn, against the solid RECORDED one. */
const HATCH = {
  backgroundImage:
    "repeating-linear-gradient(135deg, hsl(var(--primary) / 0.55) 0 3px, hsl(var(--primary) / 0.12) 3px 6px)",
};

/** A stacked share bar: recorded solid, derived hatched, unattributed muted. */
function CredBar({
  recorded,
  derived,
  other = 0,
  total,
}: {
  recorded: number;
  derived: number;
  other?: number;
  total: number;
}) {
  const w = (x: number) => `${total > 0 ? Math.max(0, Math.min(100, (x / total) * 100)) : 0}%`;
  return (
    <div className="flex h-2 w-full min-w-24 overflow-hidden rounded-full bg-muted" aria-hidden>
      <div className="h-2 bg-primary" style={{ width: w(recorded) }} data-seg="recorded" />
      <div className="h-2" style={{ ...HATCH, width: w(derived) }} data-seg="derived" />
      <div className="h-2 bg-muted-foreground/40" style={{ width: w(other) }} data-seg="other" />
    </div>
  );
}

/** "est. 89%" tag for a derived figure, with the explanation on hover. */
function EstTag({ accuracy, hint }: { accuracy: number | null; hint?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="ml-1.5 cursor-help rounded-full border border-dashed px-1.5 py-px text-[0.6rem] font-normal uppercase tracking-wide text-muted-foreground">
          est.{accuracy != null ? ` ${Math.round(accuracy * 100)}%` : ""}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">
        {hint ||
          (accuracy != null
            ? `Derived, not declared on the plan. Backtested accuracy about ${Math.round(accuracy * 100)}%.`
            : "Derived, not declared on the plan. This basis has not been backtested.")}
      </TooltipContent>
    </Tooltip>
  );
}

function PathSection({
  block,
  report,
  perProduct,
}: {
  block: PathBlock;
  report: PestAttributionReport;
  perProduct: boolean;
}) {
  const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;
  const c = block.chemical;
  const total = block.total;
  const isDirect = block.path === "direct";
  const chemTotal = c.total || 0;
  return (
    <section className="flex flex-col gap-4" aria-label={PATH_TITLE[block.path]}>
      <div>
        <h2 className="text-lg font-semibold">{PATH_TITLE[block.path]}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {isDirect
            ? block.explain
            : `${block.plans_completed ?? 0} completed plans. Only plans that were manufactured and issued to a greenhouse count.`}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-1">
            <CardDescription>Total</CardDescription>
            <CardTitle className="text-xl tabular-nums">{money(total)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {isDirect && block.by_source
              ? `From a Material Request ${money(block.by_source.from_material_request)} · no request ${money(block.by_source.no_material_request)}`
              : block.in_progress && block.in_progress.plans > 0
                ? `Not counted: ${block.in_progress.plans} plans in progress / not issued, ${money(block.in_progress.value)}`
                : "Pest control plus non-pest inputs"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardDescription>Recorded on the plan</CardDescription>
            <CardTitle className="text-xl tabular-nums">{money(c.recorded)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Declared per chemical, 100% credible
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardDescription>
              Derived
              <EstTag accuracy={c.derived_accuracy} />
            </CardDescription>
            <CardTitle className="text-xl tabular-nums">{money(c.derived)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {c.derived_accuracy != null
              ? `Spend-weighted estimated accuracy ${Math.round(c.derived_accuracy * 100)}%`
              : "Estimated from ingredients and history"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardDescription className="flex items-center gap-1.5">
              <TriangleAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-500" />
              Unattributed
            </CardDescription>
            <CardTitle className="text-xl tabular-nums">{money(c.unattributed)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {chemTotal ? pct(c.unattributed / chemTotal) : "0%"} of chemical spend
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">How the spend was assigned</CardTitle>
          <CardDescription>
            Spend by basis. Hover a basis for how far to trust it; derived figures are estimates.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-x-6 gap-y-2 sm:grid-cols-2" data-testid={`basis-${block.path}`}>
          {block.by_basis.length === 0 ? (
            <span className="text-sm text-muted-foreground">Nothing in this period.</span>
          ) : null}
          {block.by_basis.map((b) => {
            const cred = credibilityLabel(b.basis, block.path, report.accuracy);
            return (
              <div key={b.basis} className="min-w-0">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center truncate">
                    <span className="truncate">{cred.label}</span>
                    {cred.kind === "derived" ? <EstTag accuracy={cred.accuracy} /> : null}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {money(b.value)} · {pct(b.share)}
                  </span>
                </div>
                <CredBar
                  recorded={cred.kind === "recorded" ? b.value : 0}
                  derived={cred.kind === "derived" ? b.value : 0}
                  other={cred.kind === "recorded" || cred.kind === "derived" ? 0 : b.value}
                  total={total}
                />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Chemical spend by pest and disease</CardTitle>
          <CardDescription className="flex items-start gap-1.5">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Solid is recorded on the plan; hatched is derived (estimated). Non-pest inputs (foliar, adjuvant, pH buffer,
            hygiene, post-harvest) are listed separately below and never added to these rows.
          </CardDescription>
        </CardHeader>
        <CardContent className={`${BOX} p-0`}>
          <table className="w-full border-collapse text-sm">
            <thead className={TH}>
              <tr>
                <th className="px-3 py-2 text-left">Pest / disease</th>
                <th className="w-1/4 px-3 py-2 text-left">Recorded vs derived</th>
                <th className="px-3 py-2 text-right">Recorded</th>
                <th className="px-3 py-2 text-right">Derived</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-right">%</th>
              </tr>
            </thead>
            <tbody>
              {c.by_pest.map((t) => (
                <tr key={t.target} className="border-b hover:bg-muted/40">
                  <td className="px-3 py-2 align-top">
                    <div className="flex items-center gap-1.5 font-medium">
                      {t.target}
                      {t.kind ? (
                        <span className="text-[0.65rem] font-normal uppercase tracking-wide text-muted-foreground">
                          {t.kind}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t.products
                        .slice(0, 3)
                        .map((p) => `${p.item_name} ${money(p.value)}${isDirect && p.plan_uses ? ` (in ${p.plan_uses} plans)` : ""}`)
                        .join(" · ")}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <CredBar recorded={t.recorded} derived={t.derived} total={chemTotal} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{t.recorded ? money(t.recorded) : "-"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {t.derived ? (
                      <>
                        {money(t.derived)}
                        <EstTag accuracy={t.est_accuracy} />
                      </>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{money(t.value)}</td>
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
                    {isDirect
                      ? "Issued with no plan, and nothing known about the product to tie it to a pest"
                      : "The plan has no targets"}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <CredBar recorded={0} derived={0} other={c.unattributed} total={chemTotal} />
                </td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2" />
                <td className="px-3 py-2 text-right font-medium tabular-nums">{money(c.unattributed)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {chemTotal ? pct(c.unattributed / chemTotal) : "0%"}
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td className="px-3 py-2">Chemical spend</td>
                <td />
                <td className="px-3 py-2 text-right tabular-nums">{money(c.recorded)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(c.derived)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(chemTotal)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Leaf className="h-4 w-4 text-emerald-600 dark:text-emerald-500" />
            Non-pest inputs
          </CardTitle>
          <CardDescription>
            Reported apart from pest cost and never added into it. Each group says how it is treated.
          </CardDescription>
        </CardHeader>
        <CardContent className={`${BOX} p-0`}>
          <table className="w-full border-collapse text-sm" data-testid={`nonpest-${block.path}`}>
            <tbody>
              {block.nonpest.groups.map((g) => (
                <tr key={g.group} className="border-b hover:bg-muted/40">
                  <td className="px-3 py-2 align-top">
                    <div className="font-medium">{g.group}</div>
                    <div className="text-xs text-muted-foreground">{g.treatment}</div>
                    {g.group === "Unclassified" && g.value > 0 ? (
                      <div className="mt-0.5 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-500">
                        <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                        Set the cost group of these products in Suggested pest registrations below.
                      </div>
                    ) : null}
                    {g.by_target.length ? (
                      <div className="text-xs text-muted-foreground">
                        {g.by_target.map((t) => `${t.target} ${money(t.value)}`).join(" · ")}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right align-top tabular-nums">{money(g.value)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td className="px-3 py-2">Non-pest inputs</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(block.nonpest.total)}</td>
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>

      {perProduct && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">By product</CardTitle>
          </CardHeader>
          <CardContent className={`${BOX} p-0`}>
            <table className="w-full border-collapse text-sm">
              <thead className={TH}>
                <tr>
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-left">Attributed to</th>
                  {isDirect ? <th className="px-3 py-2 text-right">From a request</th> : null}
                  <th className="px-3 py-2 text-right">Spend</th>
                </tr>
              </thead>
              <tbody>
                {block.by_product.map((p) => (
                  <tr key={p.item_code} className="border-b last:border-0 hover:bg-muted/40">
                    <td className="px-3 py-2">
                      <span className="font-medium">{p.item_name}</span>{" "}
                      <span className="font-mono text-xs text-muted-foreground">{p.item_code}</span>
                      {p.nonpest ? <span className="ml-1.5 text-[0.65rem] uppercase text-muted-foreground">{p.group}</span> : null}
                      {isDirect && p.plan_uses > 0 ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="ml-1.5 cursor-help rounded-full bg-primary/10 px-1.5 py-px text-[0.6rem] font-medium text-primary">
                              Used in spray plans ({p.plan_uses})
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-xs">
                            Also used on {p.plan_uses} spray plans in the last year. Its pest shares come from that spray-plan history.
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {p.targets.map((t) => `${t.target} ${money(t.value)}`).join(" · ") || "-"}
                    </td>
                    {isDirect ? <td className="px-3 py-2 text-right tabular-nums">{money(p.from_mr)}</td> : null}
                    <td className="px-3 py-2 text-right font-medium tabular-nums">{money(p.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">By greenhouse</CardTitle>
          <CardDescription>
            {isDirect
              ? "These issues name no greenhouse, so the spend is shown at farm level with its cost centre."
              : "The greenhouse the tank mix was issued to."}
          </CardDescription>
        </CardHeader>
        <CardContent className={`${BOX} p-0`}>
          <table className="w-full border-collapse text-sm">
            <thead className={TH}>
              <tr>
                <th className="px-3 py-2 text-left">Farm</th>
                <th className="px-3 py-2 text-left">{isDirect ? "Where" : "Greenhouse"}</th>
                <th className="px-3 py-2 text-left">Cost centre</th>
                <th className="px-3 py-2 text-right">Chemical</th>
                <th className="px-3 py-2 text-right">Non-pest</th>
                <th className="px-3 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {block.by_greenhouse.map((p, i) => (
                <tr key={`${p.farm}-${p.greenhouse}-${p.cost_center}-${i}`} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="px-3 py-2 text-xs text-muted-foreground">{p.farm || "-"}</td>
                  <td className="px-3 py-2 font-medium">{p.greenhouse}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{p.cost_center || "-"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(p.chemical)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(p.nonpest)}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{money(p.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </section>
  );
}

export function Finance({ initialCrop: _initialCrop }: { initialCrop?: string } = {}) {
  const [from, setFrom] = useState<string>(monthStart);
  const [to, setTo] = useState<string>(() => ymd(new Date()));
  const [pathLabel, setPathLabel] = useState("Both");
  const [pests, setPests] = useState<string[]>([]);
  const [greenhouse, setGreenhouse] = useState("");
  const [perProduct, setPerProduct] = useState(false);
  const [data, setData] = useState<PestAttributionReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = PATH_OPTIONS[pathLabel] ?? "both";
  const filters = useMemo(() => ({ from, to, path, pests, greenhouse }), [from, to, path, pests, greenhouse]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchPestAttribution(filters)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e?.message || "Failed to load finances"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [filters]);

  // Pest and greenhouse options come from the unfiltered view, so a filter never hides its own choices.
  const [pestOptions, setPestOptions] = useState<string[]>([]);
  const [ghOptions, setGhOptions] = useState<string[]>([]);
  useEffect(() => {
    if (!data) return;
    setPestOptions((prev) => [...new Set([...prev, ...data.pest_options, "Non-pest inputs"])].sort());
    setGhOptions((prev) => [...new Set([...prev, ...data.greenhouse_options])].sort());
  }, [data]);


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

  async function changeGroup(product: string, group: string) {
    if (!group) return;
    try {
      await setCostGroup(product, group);
      void loadSuggested();
      void fetchPestAttribution(filters).then(setData);
    } catch (e) {
      setRegError(e instanceof Error ? e.message : "Could not set the cost group");
    }
  }

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
  const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;

  const blocks = data ? ([data.spray, data.direct].filter(Boolean) as PathBlock[]) : [];
  const hasData = !!data && data.combined.total > 0;
  const empty = !loading && !error && data && !hasData;
  const c = data?.combined;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex min-h-svh w-full min-w-0 flex-col">
        <PageHeader
          eyebrow={<>Crop-protection spend, stock-ledger actuals, by pest and disease</>}
          title={<>Finances</>}
        />
        {/* Filters stay pinned while the report scrolls beneath. */}
        <div className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b bg-background/95 px-4 py-2 backdrop-blur md:px-6">
          <DatePicker value={from} onChange={setFrom} />
          <DatePicker value={to} onChange={setTo} />
          <FilterSelect label="Path" value={pathLabel} onChange={(v) => setPathLabel(v || "Both")} options={Object.keys(PATH_OPTIONS)} />
          <MultiFilterSelect label="Pests" values={pests} onChange={setPests} options={pestOptions} allLabel="All pests" />
          <FilterSelect
            label="Greenhouse"
            value={greenhouse}
            onChange={setGreenhouse}
            options={ghOptions}
            allLabel="All greenhouses"
          />
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox checked={perProduct} onCheckedChange={(v) => setPerProduct(v === true)} aria-label="Breakdown per product" />
            Breakdown per product
          </label>
          <Button asChild size="sm" variant="outline" className="ml-auto rounded-full">
            <a href={pestAttributionExportUrl(filters, perProduct)} download>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Export Excel
            </a>
          </Button>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-8 px-4 py-4 md:px-6 md:py-6">
          <LoadProgress active={loading} label="Reading the stock ledger" />

          {error ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-destructive">{error}</CardContent>
            </Card>
          ) : null}

          {data?.notes.map((n) => (
            <div key={n} className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {n}
            </div>
          ))}

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

          {empty ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No product consumed in this period.
              </CardContent>
            </Card>
          ) : null}

          {hasData && data && c && (
            <>
              {blocks.map((b) => (
                <PathSection key={b.path} block={b} report={data} perProduct={perProduct} />
              ))}

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <CircleCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-500" />
                    Combined total
                  </CardTitle>
                  <CardDescription>Both paths added together, checked against the Stock Ledger.</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <table className="w-full border-collapse text-sm">
                    <tbody>
                      {blocks.map((b) => (
                        <tr key={b.path} className="border-b">
                          <td className="px-3 py-2">{PATH_TITLE[b.path]}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(b.total)}</td>
                        </tr>
                      ))}
                      <tr className="border-b font-semibold">
                        <td className="px-3 py-2">Total</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(c.total)}</td>
                      </tr>
                      {c.ledger_total != null ? (
                        <tr className="border-b">
                          <td className="px-3 py-2">Stock Ledger</td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(c.ledger_total)}</td>
                        </tr>
                      ) : null}
                      {c.ledger_difference != null ? (
                        <tr>
                          <td className="px-3 py-2 text-muted-foreground">
                            Difference (cent rounding per line)
                            {c.fallback_lines ? ` · ${c.fallback_lines} lines priced from the entry, not the ledger` : ""}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {Math.abs(c.ledger_difference) < 0.5 ? "Reconciles" : money(c.ledger_difference)}
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </>
          )}

        {canRegister && suggested.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Suggested pest registrations</CardTitle>
              <CardDescription>
                Products with no registered targets, and where the last 180 days of plans used them (at least 3
                plans, 30% or more of use). Registering makes their cost attribute by registration. Products
                no one has placed (never on a plan, no ingredient known) are listed to have their cost group set.
              </CardDescription>
            </CardHeader>
            <CardContent className={`${BOX} p-0`}>
              <table className="w-full border-collapse text-sm">
                <thead className={TH}>
                  <tr>
                    <th className="px-3 py-2 text-left">Product</th>
                    <th className="px-3 py-2 text-left">Cost group</th>
                    <th className="px-3 py-2 text-right">Plans</th>
                    <th className="px-3 py-2 text-left">Suggested targets</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {suggested.map((x) => (
                    <tr key={x.product} className="border-b last:border-0">
                      <td className="px-3 py-2 font-medium">{x.product_name}</td>
                      <td className="px-3 py-2">
                        <FilterSelect
                          label={`Cost group for ${x.product_name}`}
                          value={x.cost_group || ""}
                          onChange={(g) => void changeGroup(x.product, g)}
                          options={COST_GROUPS}
                          allLabel={x.unclassified ? "Set cost group" : undefined}
                          className="h-7 min-w-[8rem] px-3 text-[0.7rem]"
                        />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{x.plans}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {x.suggestions.map((g) => `${g.target} ${pct(g.share)}`).join(" · ")}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {x.suggestions.length ? (
                          <Button size="sm" variant="outline" onClick={() => { setRegError(null); setPending(x); }}>
                            Register
                          </Button>
                        ) : null}
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

        </div>
      </div>
    </TooltipProvider>
  );
}
