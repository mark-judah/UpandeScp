/**
 * Ranked "Suggested products" for the plan's targets and greenhouse(s).
 * The server ranks (`spray_compliance.suggest`); this presents the list and
 * hands a tapped product back to the page, which adds it with its default rate.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Plus } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  suggestProducts,
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

  const needs = !targets.length
    ? "targets"
    : !greenhouses.length
      ? "greenhouse"
      : !sourceWarehouse
        ? "store"
        : null;
  const rows = data?.suggestions ?? [];

  return (
    <Frame embedded={embedded}>
      <CardHeader className="p-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          Suggested products
          {loading && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          )}
        </CardTitle>
        <CardDescription>
          Registered for your targets, passing the spray checks, with usable
          stock in {sourceWarehouse || "the source store"}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 p-0">
        {needs ? (
          <span className="text-xs text-muted-foreground">{NEEDS[needs]}</span>
        ) : failed ? (
          <span className="text-xs text-muted-foreground">
            Suggestions could not be loaded.
          </span>
        ) : !rows.length && !loading ? (
          <span className="text-xs text-muted-foreground">
            No product is both registered for these targets and in stock here.
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
                  "flex items-start gap-3 rounded-md border bg-card px-3 py-2 text-left transition-colors enabled:hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 " +
                  (p.eligible ? "" : "opacity-80")
                }
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs font-medium">
                      {p.item_name}
                    </span>
                    <ScoreDots n={p.dots} score={p.score} />
                  </div>
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
                <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[0.6rem] text-muted-foreground">
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
