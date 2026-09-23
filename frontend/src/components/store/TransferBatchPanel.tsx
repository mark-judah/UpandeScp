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

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronsUpDown, Loader2, Search, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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

/**
 * The batch picker: a search box over the batches this store actually holds.
 *
 * A plain dropdown was not enough. A chemical can have dozens of live batches
 * and their codes differ by four digits in the middle — `ROSE-2026-01125`
 * against `ROSE-2026-01165` — so scrolling a list to find the drum in your hand
 * is exactly the reading task that produced the wrong batch in the first place.
 * Typing the last few digits is how someone with a label in front of them
 * actually looks something up.
 *
 * The list stays in the rule's order, so the best choice is still the first
 * thing under the cursor when the box opens and nobody has typed anything.
 */
function BatchCombobox({
  options,
  value,
  onChange,
}: {
  options: BatchOption[];
  value: string | null;
  onChange: (batch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((o) => o.batch_no.toLowerCase().includes(needle));
  }, [options, q]);

  const current = options.find((o) => o.batch_no === value);

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQ("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "w-full max-w-md justify-between font-mono text-[0.7rem] font-normal",
            current?.placeholder && "border-destructive/50 text-destructive",
          )}
        >
          <span className="truncate">
            {current ? current.batch_no : "Choose a batch…"}
          </span>
          <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[26rem] p-0" align="start">
        <div className="flex items-center gap-2 border-b px-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Type any part of the batch code…"
            className="h-9 border-0 px-0 text-xs shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {!hits.length ? (
            <div className="px-3 py-4 text-center text-[0.7rem] text-muted-foreground">
              No batch here matches “{q}”.
            </div>
          ) : (
            hits.map((o) => (
              <button
                key={o.batch_no}
                type="button"
                onClick={() => {
                  onChange(o.batch_no);
                  setOpen(false);
                  setQ("");
                }}
                className={cn(
                  "flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-muted/60",
                  o.batch_no === value && "bg-muted",
                )}
              >
                <Check
                  className={cn(
                    "mt-0.5 h-3 w-3 shrink-0",
                    o.batch_no === value ? "opacity-100" : "opacity-0",
                  )}
                />
                <BatchLine o={o} />
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
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

  // Loaded as soon as the draft is opened. This table IS the transfer's item
  // list now — the batch sits beside the store the drum goes to, rather than in
  // a second table underneath repeating the same rows. One call does both jobs.
  useEffect(() => {
    void propose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

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
  const blockedCount = pending.filter((r) => !r.options.length).length;

  if (!rows) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {loading ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading chemicals and batches…
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={propose}>
              <Sparkles className="h-3.5 w-3.5" />
              Load chemicals
            </Button>
            {error && <span className="text-destructive">{error}</span>}
          </>
        )}
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
        {blockedCount > 0 && (
          <span className="inline-flex items-center gap-1 text-[0.7rem] font-medium text-destructive">
            <AlertTriangle className="h-3 w-3" />
            {blockedCount} with no stock in this store
          </span>
        )}
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
        {pending.length > 0 && (
          <span className="text-[0.7rem] text-muted-foreground">
            First-expiry-first-out, real stock before migration filler. You can
            change any of it.
          </span>
        )}
        {done && <span className="text-[0.7rem] text-emerald-700">{done}</span>}
        {error && <span className="text-[0.7rem] text-destructive">{error}</span>}
      </div>

      <table className="w-full text-xs">
        <thead className="text-[0.65rem] uppercase tracking-wide text-muted-foreground border-b">
          <tr>
            <th className="w-8 px-2 py-1" />
            <th className="text-left px-2 py-1">Chemical</th>
            <th className="text-right px-2 py-1">Qty</th>
            <th className="text-left px-2 py-1">UoM</th>
            <th className="text-left px-2 py-1">From</th>
            <th className="text-left px-2 py-1">To</th>
            <th className="text-left px-2 py-1">Batch</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pick = chosen[r.idx];
            const chosenOption = r.options.find((o) => o.batch_no === pick);
            const spans = r.picks.length > 1;
            // The row this transfer will die on: the chemical is batch
            // tracked, it has no batch yet, and this store holds no batch of
            // it with stock left. There is nothing to choose, so the whole row
            // is marked rather than a line of small text inside one cell —
            // this is the one thing the storesman has to take somewhere else
            // before the transfer can go at all.
            const blocked = r.needs_batch && !r.settled && !r.options.length;
            return (
              <tr
                key={r.idx}
                className={cn(
                  "border-b last:border-0 align-top",
                  blocked && "bg-destructive/10",
                )}
              >
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
                  {fmt(r.qty)}
                </td>
                <td className="px-2 py-2 text-muted-foreground">{r.uom}</td>
                <td className="px-2 py-2 text-muted-foreground truncate max-w-44">
                  {r.warehouse || "—"}
                </td>
                <td className="px-2 py-2 text-muted-foreground truncate max-w-44">
                  {r.to_warehouse || "—"}
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
                    <span className="inline-flex items-center gap-1 text-[0.7rem] font-medium text-destructive">
                      <AlertTriangle className="h-3 w-3" />
                      No batch with stock in this store — this row blocks the
                      transfer.
                    </span>
                  ) : (
                    <div className="space-y-1">
                      <BatchCombobox
                        options={r.options}
                        value={pick ?? null}
                        onChange={(v) => {
                          setChosen((prev) => ({ ...prev, [r.idx]: v }));
                          setAccepted((prev) => new Set(prev).add(r.idx));
                        }}
                      />

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
