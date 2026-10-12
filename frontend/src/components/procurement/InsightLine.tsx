/**
 * The quiet line under a chemical a planner has just added: what the farm has,
 * what it used lately, what it was approved last time, what it is owed, and the
 * value of what they typed. Muted, tabular, one line (wrapping on a phone).
 *
 * Three honest states: a skeleton while it loads, "—" if it could not be read,
 * and the figures. A missing figure is "—" too, never a made-up zero.
 */
import { TextSkeleton } from "@/components/Loading";
import { fmtQty } from "@/lib/uom";
import type { ItemInsight } from "@/lib/procurement-api";

export type InsightState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; insight: ItemInsight | undefined };

function money(n: number, currency: string) {
  return `${currency} ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.round(n))}`;
}

export function InsightLine({
  state,
  qty,
  weeks = 8,
  currency = "KES",
}: {
  state: InsightState;
  /** The quantity currently typed on the row; valued at the item's rate. */
  qty: number;
  weeks?: number;
  currency?: string;
}) {
  if (state.status === "loading") {
    return (
      <div data-testid="insight" data-loading="true" className="mt-1">
        <TextSkeleton width="38ch" />
      </div>
    );
  }
  if (state.status === "error" || !state.insight) {
    return (
      <div data-testid="insight" className="mt-1 text-xs text-muted-foreground tabular-nums">
        —
      </div>
    );
  }
  const i = state.insight;
  const unit = i.uom ? ` ${i.uom}` : "";
  const parts: { label: string; value: string }[] = [
    { label: "On hand", value: `${fmtQty(i.on_hand)}${unit}` },
    { label: `Used ${weeks} wk`, value: `${fmtQty(i.consumed)}${unit}` },
    {
      label: "Last cycle",
      value: i.last_approved === null ? "—" : `${fmtQty(i.last_approved)}${unit}`,
    },
    { label: "Credit", value: Math.abs(i.credit) < 1e-9 ? "—" : `${fmtQty(i.credit)}${unit}` },
    { label: "Rate", value: i.rate > 0 ? `${money(i.rate, currency)}/${i.uom || "unit"}` : "—" },
  ];
  if (qty > 0) {
    parts.push({ label: "This order", value: i.rate > 0 ? money(qty * i.rate, currency) : "—" });
  }
  return (
    <div
      data-testid="insight"
      className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums"
    >
      {parts.map((p) => (
        <span key={p.label}>
          {p.label} <span className="text-foreground/80">{p.value}</span>
        </span>
      ))}
    </div>
  );
}

/** A requirement's rows -> insight states, keyed by item code. */
export function insightState(
  loading: boolean,
  failed: boolean,
  items: Record<string, ItemInsight> | undefined,
  code: string,
): InsightState {
  if (failed) return { status: "error" };
  if (loading) return { status: "loading" };
  return { status: "ready", insight: items?.[code] };
}
