/**
 * Choosing batches for a draft transfer, at the counter, without guessing.
 *
 * Batch tracking is on for 533 chemicals, so a Material Transfer for
 * Manufacture will not submit until every outgoing row names a batch — and
 * nothing in SCP ever set one. The job landed here, on the person about to scan
 * a thumb and hand over the drums: open each of thirty rows, read a list of
 * near-identical codes, pick.
 *
 * What they actually picked, in the forty-five days before this was written,
 * was the migration placeholder — 5,213 rows carrying a `-PREMIGRATION` batch
 * and not one carrying a real one. Those batches hold 2.87 trillion units of
 * invented opening stock, so they never run out and never complain. That is the
 * problem this panel exists to end.
 *
 * So the rule proposes and the storesman disposes. Every row arrives with a
 * batch already chosen by first-expiry-first-out, the alternatives one click
 * away, and the numbers behind each — how much is there, when it expires, and
 * whether it is real stock or migration filler. He changes what he disagrees
 * with, ticks the rows he accepts, and applies them in one go.
 *
 * Nothing here writes on its own. Proposals live in local state until he
 * presses Apply, because a batch silently assigned is exactly how the
 * placeholder got issued five thousand times.
 */

import { useState } from "react";
import { AlertTriangle, Check, Loader2, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  applyTransferBatches,
  suggestTransferBatches,
  type BatchOption,
  type TransferBatchRow,
} from "@/lib/store-keeper-api";
import { cn } from "@/lib/utils";

function fmt(n: number): string {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

/** The one word a batch is read by, and the colour that goes with it. */
const STATUS_STYLE: Record<BatchOption["status"], { label: string; cls: string }> = {
  ok: { label: "in date", cls: "text-emerald-700 dark:text-emerald-400" },
  expiring: { label: "expiring", cls: "text-amber-700 dark:text-amber-400" },
  expired: { label: "expired", cls: "text-destructive" },
  undated: { label: "no expiry", cls: "text-muted-foreground" },
  placeholder: { label: "migration filler", cls: "text-destructive" },
};

/**
 * One batch, written out the way the storesman needs to read it.
 *
 * Quantity first: it is the thing he checks against the drum in his hand. The
 * placeholder warning is spelled out rather than shown as a colour, because the
 * whole failure was people treating these as ordinary stock.
 */
function BatchLine({ o }: { o: BatchOption }) {
  const s = STATUS_STYLE[o.status];
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <span className="font-mono text-[0.7rem]">{o.batch_no}</span>
      <span className="tabular-nums text-[0.65rem] text-muted-foreground">
        {fmt(o.qty)} available
      </span>
      <span className={cn("text-[0.65rem]", s.cls)}>
        {o.status === "placeholder"
          ? "migration filler — not real stock"
          : o.days_to_expiry !== null
            ? `${s.label} · ${o.days_to_expiry}d`
            : s.label}
      </span>
    </span>
  );
}

export function TransferBatchPanel({
  name,
  onApplied,
}: {
  name: string;
  /** The parent refreshes its draft list — item counts and totals do not change,
   *  but a row that was blocking submission no longer is. */
  onApplied?: () => void;
}) {
  const [rows, setRows] = useState<TransferBatchRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** Row index -> the batch chosen for it, starting from the proposal. */
  const [chosen, setChosen] = useState<Record<number, string>>({});
  /** Which rows the storesman has agreed to. Nothing is applied unticked. */
  const [accepted, setAccepted] = useState<Set<number>>(new Set());

  const propose = async () => {
    setLoading(true);
    setError(null);
    setDone(null);
    try {
      const r = await suggestTransferBatches(name);
      setRows(r.rows);
      const picks: Record<number, string> = {};
      const tick = new Set<number>();
      for (const row of r.rows) {
        if (row.needs_batch && !row.settled && row.suggestion) {
          picks[row.idx] = row.suggestion;
          // Pre-ticked: the common case is agreeing with all of it, and making
          // him tick thirty boxes to accept the default would just teach him to
          // tick without reading.
          tick.add(row.idx);
        }
      }
      setChosen(picks);
      setAccepted(tick);
    } catch (e: any) {
      setError(e?.message ?? "Could not work out the batches.");
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    const picks: Record<number, string> = {};
    for (const idx of accepted) if (chosen[idx]) picks[idx] = chosen[idx];
    if (!Object.keys(picks).length) return;
    setApplying(true);
    setError(null);
    try {
      const r = await applyTransferBatches(name, picks);
      setDone(`${r.updated} row${r.updated === 1 ? "" : "s"} updated.`);
      await propose(); // re-read, so applied rows come back as settled
      onApplied?.();
    } catch (e: any) {
      setError(e?.message ?? "Could not save the batches.");
    } finally {
      setApplying(false);
    }
  };

  const pending = rows?.filter((r) => r.needs_batch && !r.settled) ?? [];
  const acceptedCount = pending.filter(
    (r) => accepted.has(r.idx) && chosen[r.idx],
  ).length;

  if (!rows) {
    return (
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" onClick={propose} disabled={loading}>
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          Propose batches
        </Button>
        <span className="text-[0.7rem] text-muted-foreground">
          First-expiry-first-out, real stock before migration filler. You can
          change any of it.
        </span>
        {error && <span className="text-[0.7rem] text-destructive">{error}</span>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[0.7rem] text-muted-foreground">
          {pending.length
            ? `${pending.length} row${pending.length === 1 ? "" : "s"} need a batch`
            : "Every row has a batch."}
        </span>
        {pending.length > 0 && (
          <Button size="sm" onClick={apply} disabled={applying || !acceptedCount}>
            {applying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            Apply to {acceptedCount} row{acceptedCount === 1 ? "" : "s"}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={propose} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Re-check stock
        </Button>
        {done && <span className="text-[0.7rem] text-emerald-700">{done}</span>}
        {error && <span className="text-[0.7rem] text-destructive">{error}</span>}
      </div>

      <table className="w-full text-xs">
        <thead className="text-[0.65rem] uppercase tracking-wide text-muted-foreground border-b">
          <tr>
            <th className="w-8 px-2 py-1" />
            <th className="text-left px-2 py-1">Chemical</th>
            <th className="text-right px-2 py-1">Qty</th>
            <th className="text-left px-2 py-1">From</th>
            <th className="text-left px-2 py-1">Batch</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pick = chosen[r.idx];
            const chosenOption = r.options.find((o) => o.batch_no === pick);
            const spans = r.picks.length > 1;
            return (
              <tr key={r.idx} className="border-b last:border-0 align-top">
                <td className="px-2 py-2">
                  {r.needs_batch && !r.settled && (
                    <Checkbox
                      checked={accepted.has(r.idx)}
                      disabled={!pick}
                      onCheckedChange={() =>
                        setAccepted((prev) => {
                          const next = new Set(prev);
                          next.has(r.idx) ? next.delete(r.idx) : next.add(r.idx);
                          return next;
                        })
                      }
                    />
                  )}
                </td>
                <td className="px-2 py-2">
                  <div className="font-medium">{r.item_name}</div>
                  <div className="text-[0.6rem] text-muted-foreground font-mono">
                    {r.item_code}
                  </div>
                </td>
                <td className="px-2 py-2 text-right tabular-nums font-medium whitespace-nowrap">
                  {fmt(r.qty)} {r.uom}
                </td>
                <td className="px-2 py-2 text-muted-foreground truncate max-w-44">
                  {r.warehouse || "—"}
                </td>
                <td className="px-2 py-2">
                  {!r.needs_batch ? (
                    <span className="text-[0.65rem] text-muted-foreground italic">
                      not batch tracked
                    </span>
                  ) : r.settled ? (
                    <Badge variant="outline" className="font-mono text-[0.65rem]">
                      {r.batch_no}
                    </Badge>
                  ) : !r.options.length ? (
                    <span className="inline-flex items-center gap-1 text-[0.7rem] text-destructive">
                      <AlertTriangle className="h-3 w-3" />
                      no stock in this store
                    </span>
                  ) : (
                    <div className="space-y-1">
                      <select
                        value={pick ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          setChosen((prev) => ({ ...prev, [r.idx]: v }));
                          setAccepted((prev) => new Set(prev).add(r.idx));
                        }}
                        className="w-full max-w-md rounded border bg-background px-2 py-1 text-[0.7rem] font-mono"
                      >
                        {r.options.map((o) => (
                          <option key={o.batch_no} value={o.batch_no}>
                            {o.batch_no} · {fmt(o.qty)} available ·{" "}
                            {o.status === "placeholder"
                              ? "migration filler"
                              : STATUS_STYLE[o.status].label}
                          </option>
                        ))}
                      </select>

                      {/* The info panel: why this batch, and what it is. */}
                      {chosenOption && (
                        <div
                          className={cn(
                            "rounded border px-2 py-1.5 text-[0.65rem] leading-relaxed",
                            chosenOption.placeholder
                              ? "border-destructive/40 bg-destructive/5"
                              : "bg-background",
                          )}
                        >
                          <BatchLine o={chosenOption} />
                          {chosenOption.placeholder && (
                            <div className="mt-1 text-destructive">
                              This is opening stock the migration invented, not a
                              real delivery. Issue it only if the store genuinely
                              has nothing else on the system.
                            </div>
                          )}
                          {spans && (
                            <div className="mt-1 text-muted-foreground">
                              {fmt(r.qty)} {r.uom} spans {r.picks.length} batches:{" "}
                              {r.picks
                                .map((p) => `${p.batch_no} (${fmt(p.qty)})`)
                                .join(", ")}
                              . The row takes the first; split it to use the rest.
                            </div>
                          )}
                          {r.short > 0 && (
                            <div className="mt-1 inline-flex items-center gap-1 text-destructive">
                              <AlertTriangle className="h-3 w-3" />
                              {fmt(r.short)} {r.uom} short of what this row needs.
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
