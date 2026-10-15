/**
 * Ranked "Suggested products" for the plan's targets and greenhouse(s).
 * The server ranks (`spray_compliance.suggest`); this presents the list and
 * hands a tapped product back to the page, which adds it with its default rate.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Check, Layers, Loader2, Plus, Sparkles } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  suggestMix,
  suggestProducts,
  type SuggestedMixes,
  type SuggestedProduct,
  type SuggestedProducts,
} from "@/lib/spray-compliance-api";

const NEEDS: Record<string, string> = {
  targets: "Pick targets to see suggested products.",
  greenhouse: "Pick a greenhouse to see suggested products.",
  store:
    "Pick a tank mix or add a chemical first so the source store is known.",
};

/** 1-5 filled dots for a score. */
export function ScoreDots({ n, score }: { n: number; score: number }) {
  return (
    <span
      className="inline-flex items-center gap-0.5"
      role="img"
      aria-label={`Rating ${n} of 5`}
      title={`Score ${Math.round(score)} of 100`}
    >
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={
            "h-1.5 w-1.5 rounded-full " +
            (i <= n ? "bg-primary" : "bg-muted-foreground/25")
          }
        />
      ))}
    </span>
  );
}

export function SuggestedProductsCard({
  targets,
  greenhouses,
  sourceWarehouse,
  currentItems,
  when,
  canAdd = true,
  embedded = false,
  onAdd,
  onAddMix,
  onSuggested,
}: {
  targets: string[];
  greenhouses: string[];
  sourceWarehouse: string;
  currentItems: string[];
  when?: string;
  /** False until the plan has a tank mix to add into. */
  canAdd?: boolean;
  /** Render as a section inside a host card (the tank mix card) instead of a card of its own. */
  embedded?: boolean;
  onAdd: (p: SuggestedProduct) => void;
  /** Add a whole proposed tank mix (replacing the rows, once confirmed). */
  onAddMix?: (products: SuggestedProduct[]) => void;
  /** Item codes currently suggested, so the chemical picker can mark them. */
  onSuggested?: (codes: string[]) => void;
}) {
  const [data, setData] = useState<SuggestedProducts | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const key = JSON.stringify([
    targets,
    greenhouses,
    sourceWarehouse,
    currentItems,
    when,
  ]);

  const [mixOpen, setMixOpen] = useState(false);
  const [mixes, setMixes] = useState<SuggestedMixes | null>(null);
  const [mixLoading, setMixLoading] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);
  const mixKey = JSON.stringify([targets, greenhouses, sourceWarehouse, when]);

  useEffect(() => {
    if (!mixOpen || !targets.length || !greenhouses.length || !sourceWarehouse) {
      setMixes(null);
      return;
    }
    let cancelled = false;
    setMixLoading(true);
    suggestMix({ targets, greenhouses, sourceWarehouse, currentItems, when })
      .then((r) => !cancelled && setMixes(r))
      .catch(() => !cancelled && setMixes(null))
      .finally(() => !cancelled && setMixLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mixOpen, mixKey]);

  const addWholeMix = (i: number) => {
    const m = mixes?.mixes[i];
    if (!m) return;
    if (currentItems.length && confirming !== i) {
      setConfirming(i);
      return;
    }
    setConfirming(null);
    onAddMix?.(m.products);
  };

  useEffect(() => {
    if (!targets.length || !greenhouses.length || !sourceWarehouse) {
      setData(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      suggestProducts({
        targets,
        greenhouses,
        sourceWarehouse,
        currentItems,
        when,
      })
        .then((r) => !cancelled && (setData(r), setFailed(false)))
        .catch(() => !cancelled && (setData(null), setFailed(true)))
        .finally(() => !cancelled && setLoading(false));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    onSuggested?.((data?.suggestions ?? []).map((p) => p.item_code));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const needs = !targets.length
    ? "targets"
    : !greenhouses.length
      ? "greenhouse"
      : !sourceWarehouse
        ? "store"
        : null;
  const rows = data?.suggestions ?? [];

  const covered = data?.covered ?? [];
  const remaining = data?.remaining_targets ?? targets;

  return (
    <Frame embedded={embedded}>
      <CardHeader className="p-0 pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            Suggested products
            {loading && (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            )}
          </CardTitle>
          {onAddMix && !needs && (
            <button
              type="button"
              disabled={!canAdd}
              onClick={() => setMixOpen((o) => !o)}
              aria-pressed={mixOpen}
              data-testid="suggest-mix-toggle"
              className={
                "inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-[0.65rem] transition-colors disabled:opacity-50 " +
                (mixOpen
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-primary/40 text-primary hover:bg-primary/10")
              }
            >
              <Layers className="h-3 w-3" />
              Suggested tank mix
            </button>
          )}
        </div>
        <CardDescription>
          Registered for your targets, passing the spray checks, with usable
          stock in {sourceWarehouse || "the source store"}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 p-0">
        {mixOpen && !needs && (
          <MixPanel
            mixes={mixes}
            loading={mixLoading}
            confirming={confirming}
            replacing={currentItems.length}
            canAdd={canAdd}
            onAdd={addWholeMix}
            onCancel={() => setConfirming(null)}
          />
        )}
        {covered.length > 0 && (
          <div className="flex flex-col gap-0.5" data-testid="covered-targets">
            {covered.map((c) => (
              <span
                key={c.target}
                className="inline-flex items-center gap-1 text-[0.65rem] text-muted-foreground"
              >
                <Check className="h-3 w-3 text-primary" />
                {c.target} covered by {c.products.join(", ")}
              </span>
            ))}
          </div>
        )}
        {needs ? (
          <span className="text-xs text-muted-foreground">{NEEDS[needs]}</span>
        ) : failed ? (
          <span className="text-xs text-muted-foreground">
            Suggestions could not be loaded.
          </span>
        ) : data?.all_covered ? (
          <span className="text-xs text-muted-foreground" data-testid="all-covered">
            Every selected target is covered by the tank mix.
          </span>
        ) : !rows.length && !loading ? (
          <span className="text-xs text-muted-foreground">
            No product is both registered for {covered.length ? "the remaining" : "these"} targets and in stock here.
          </span>
        ) : (
          <>
            {!canAdd && (
              <span className="text-[0.65rem] text-muted-foreground">
                Pick a tank mix, then tap a product to add it.
              </span>
            )}
            {rows.map((p) => (
              <button
                key={p.item_code}
                type="button"
                disabled={!canAdd}
                onClick={() => onAdd(p)}
                data-testid={`suggest-${p.item_code}`}
                className={
                  "flex items-start gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-left transition-colors enabled:hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60 " +
                  (p.eligible ? "" : "opacity-80")
                }
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <SuggestedPill />
                    <span className="truncate text-xs font-medium">
                      {p.item_name}
                    </span>
                    <ScoreDots n={p.dots} score={p.score} />
                  </div>
                  <TargetPills
                    covered={p.covered_targets}
                    uncovered={p.uncovered_targets ?? remaining.filter((t) => !p.covered_targets.includes(t))}
                  />
                  <div className="text-[0.65rem] text-muted-foreground">
                    {p.reason}
                  </div>
                  {!p.eligible &&
                    p.warnings.slice(0, 2).map((w) => (
                      <div
                        key={w}
                        className="mt-0.5 flex items-start gap-1 text-[0.65rem] text-amber-700 dark:text-amber-300"
                      >
                        <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" />
                        <span>{w}</span>
                      </div>
                    ))}
                </div>
                <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/40 px-2 py-0.5 text-[0.6rem] text-primary">
                  <Plus className="h-3 w-3" />
                  {p.default_rate ? `${p.default_rate} / 1000 L` : "Add"}
                </span>
              </button>
            ))}
          </>
        )}
      </CardContent>
    </Frame>
  );
}

/** The accent pill that marks a suggested product wherever it appears. */
export function SuggestedPill({ className = "" }: { className?: string }) {
  return (
    <span
      data-testid="suggested-pill"
      className={
        "inline-flex items-center gap-0.5 rounded-full bg-primary px-1.5 py-0 text-[0.6rem] font-medium text-primary-foreground " +
        className
      }
    >
      <Sparkles className="h-2.5 w-2.5" />
      Suggested
    </span>
  );
}

/** The plan targets a product is for (accent) and, muted, the ones it is not. */
function TargetPills({ covered, uncovered }: { covered: string[]; uncovered: string[] }) {
  if (!covered.length && !uncovered.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1" data-testid="target-pills">
      {covered.map((t) => (
        <span
          key={t}
          data-testid="target-covered"
          className="rounded-full border border-primary/50 bg-primary/15 px-1.5 text-[0.6rem] text-foreground"
        >
          {t}
        </span>
      ))}
      {uncovered.map((t) => (
        <span
          key={t}
          data-testid="target-uncovered"
          className="rounded-full border px-1.5 text-[0.6rem] text-muted-foreground/70"
          title="Not registered for this target"
        >
          {t}
        </span>
      ))}
    </div>
  );
}

function MixPanel({
  mixes,
  loading,
  confirming,
  replacing,
  canAdd,
  onAdd,
  onCancel,
}: {
  mixes: SuggestedMixes | null;
  loading: boolean;
  confirming: number | null;
  replacing: number;
  canAdd: boolean;
  onAdd: (i: number) => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-primary/30 bg-primary/5 p-2" data-testid="mix-panel">
      {loading && !mixes ? (
        <span className="text-xs text-muted-foreground">Working out mixes...</span>
      ) : !mixes?.mixes.length ? (
        <span className="text-xs text-muted-foreground" data-testid="no-mix">
          No combination of products in stock covers every target without breaking a spray rule.
        </span>
      ) : (
        mixes.mixes.map((m, i) => (
          <div key={i} className="rounded-md border bg-card p-2" data-testid={`mix-${i}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">
                Option {i + 1} · {m.size} product{m.size === 1 ? "" : "s"}
              </span>
              {confirming === i ? (
                <span className="flex items-center gap-1.5" data-testid="mix-confirm">
                  <span className="text-[0.65rem] text-amber-700 dark:text-amber-300">
                    Replace the {replacing} chemical{replacing === 1 ? "" : "s"} already in the tank mix?
                  </span>
                  <button
                    type="button"
                    onClick={() => onAdd(i)}
                    className="rounded-full bg-primary px-2 py-0.5 text-[0.65rem] text-primary-foreground"
                  >
                    Replace
                  </button>
                  <button type="button" onClick={onCancel} className="rounded-full border px-2 py-0.5 text-[0.65rem]">
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={!canAdd}
                  onClick={() => onAdd(i)}
                  data-testid={`mix-add-${i}`}
                  className="inline-flex items-center gap-1 rounded-full border border-primary/50 px-2 py-0.5 text-[0.65rem] text-primary hover:bg-primary/10 disabled:opacity-50"
                >
                  <Plus className="h-3 w-3" />
                  Add this mix
                </button>
              )}
            </div>
            {m.products.map((p) => (
              <div key={p.item_code} className="mt-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs">{p.item_name}</span>
                  {(p.codes ?? []).map((c) => (
                    <span key={c} className="rounded-full border px-1.5 text-[0.6rem] text-muted-foreground">
                      {c}
                    </span>
                  ))}
                </div>
                <TargetPills covered={p.covers} uncovered={[]} />
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

/** A card of its own, or a bordered section inside the tank mix card. */
function Frame({ embedded, children }: { embedded: boolean; children: React.ReactNode }) {
  return embedded ? (
    <section className="rounded-md border p-3" data-testid="suggested-products">
      {children}
    </section>
  ) : (
    <Card className="p-4" data-testid="suggested-products">
      {children}
    </Card>
  );
}
