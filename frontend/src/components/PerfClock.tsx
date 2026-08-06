import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  subscribe,
  getTotals,
  getByMethod,
  getSessionElapsedMs,
  isPerfEnabled,
  shortMethod,
  formatBytes,
  formatMs,
  formatElapsed,
  type MethodAgg,
} from "@/lib/perf";

// "Total" here is cumulative time spent waiting on `call()` (fetch + parse)
// since page load — the number that actually moves when a query gets faster
// or a payload gets fatter. A plain wall clock would drift past any threshold
// within seconds and stay red forever, which would make the colour useless.
const GREEN_MS = 2000;
const AMBER_MS = 5000;

function totalColorClass(ms: number): string {
  if (ms < GREEN_MS) return "text-[var(--sd-data-green)]";
  if (ms < AMBER_MS) return "text-[var(--sd-sev-high)]";
  return "text-[var(--sd-sev-critical)]";
}

function ratioLabel(rawBytes: number, wireBytes: number): string {
  if (wireBytes <= 0) return "—";
  return `${(rawBytes / wireBytes).toFixed(1)}×`;
}

/**
 * Opt-in performance HUD. Hidden unless `?perf=1` was ever passed in the URL
 * (or `localStorage.setItem('scp:perf','1')`) — see `lib/perf.ts`.
 *
 * Collapsed: a small badge, bottom-left, showing cumulative request time
 * (coloured), request count, and total wire bytes. Click to expand a
 * per-endpoint breakdown, slowest first, with the compression ratio that
 * proves gzip + payload trimming are actually working.
 */
export function PerfClock() {
  const [enabled] = useState(() => isPerfEnabled());
  const [expanded, setExpanded] = useState(false);
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = subscribe(() => forceTick((t) => t + 1));
    // The session clock isn't event-driven, so tick it independently.
    const interval = window.setInterval(() => forceTick((t) => t + 1), 1000);
    return () => {
      unsubscribe();
      window.clearInterval(interval);
    };
  }, [enabled]);

  if (!enabled) return null;

  const totals = getTotals();
  const requestMs = totals.fetchMs + totals.parseMs;
  const sessionMs = getSessionElapsedMs();
  const perMethod = expanded ? getByMethod() : [];

  return (
    <div className="fixed bottom-3 left-3 z-[70] select-none font-mono text-[11px] leading-tight">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title="Performance HUD — click for per-endpoint breakdown"
        className={cn(
          "flex items-center gap-2 rounded-[var(--sd-radius-pill)] border bg-card/70 px-3 py-1.5",
          "opacity-60 shadow-[var(--sd-shadow-1)] backdrop-blur-sm transition-opacity",
          "hover:opacity-100 focus-visible:opacity-100 outline-none",
        )}
      >
        <span aria-hidden className="text-[var(--sd-quiet)]">
          ⏱
        </span>
        <span
          className={cn("font-semibold tabular-nums", totalColorClass(requestMs))}
        >
          {formatMs(requestMs)}
        </span>
        <span className="text-[var(--sd-quiet)]">·</span>
        <span className="tabular-nums text-[var(--sd-muted)]">
          {totals.count} req
        </span>
        <span className="text-[var(--sd-quiet)]">·</span>
        <span className="tabular-nums text-[var(--sd-muted)]">
          {formatBytes(totals.wireBytes)}
        </span>
        <span className="text-[var(--sd-quiet)]">
          · {formatElapsed(sessionMs)} open
        </span>
      </button>

      {expanded ? (
        <div className="mt-2 w-[400px] max-h-[60vh] overflow-auto rounded-[var(--sd-radius-lg)] border bg-card p-3 shadow-[var(--sd-shadow-2)]">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--sd-quiet)]">
              Perf — per endpoint
            </span>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="text-[var(--sd-quiet)] hover:text-foreground"
              aria-label="Collapse"
            >
              ✕
            </button>
          </div>
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="text-left text-[var(--sd-quiet)]">
                <th className="pb-1 pr-2 font-medium">method</th>
                <th className="pb-1 pr-2 text-right font-medium">n</th>
                <th className="pb-1 pr-2 text-right font-medium">fetch</th>
                <th className="pb-1 pr-2 text-right font-medium">parse</th>
                <th className="pb-1 pr-2 text-right font-medium">wire → raw</th>
                <th className="pb-1 text-right font-medium">×</th>
              </tr>
            </thead>
            <tbody>
              {perMethod.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="py-3 text-center text-[var(--sd-quiet)]"
                  >
                    No calls recorded yet
                  </td>
                </tr>
              ) : (
                perMethod.map((m: MethodAgg) => (
                  <tr key={m.method} className="border-t border-[var(--sd-line)]">
                    <td
                      className="max-w-[130px] truncate py-1 pr-2"
                      title={m.method}
                    >
                      {shortMethod(m.method)}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      {m.count}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      {formatMs(m.fetchMs)}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      {formatMs(m.parseMs)}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums whitespace-nowrap">
                      {formatBytes(m.wireBytes)} → {formatBytes(m.rawBytes)}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {ratioLabel(m.rawBytes, m.wireBytes)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr className="border-t border-[var(--sd-line)] font-semibold">
                <td className="pt-1 pr-2">total</td>
                <td className="pt-1 pr-2 text-right tabular-nums">
                  {totals.count}
                </td>
                <td className="pt-1 pr-2 text-right tabular-nums">
                  {formatMs(totals.fetchMs)}
                </td>
                <td className="pt-1 pr-2 text-right tabular-nums">
                  {formatMs(totals.parseMs)}
                </td>
                <td className="pt-1 pr-2 text-right tabular-nums whitespace-nowrap">
                  {formatBytes(totals.wireBytes)} → {formatBytes(totals.rawBytes)}
                </td>
                <td className="pt-1 text-right tabular-nums">
                  {ratioLabel(totals.rawBytes, totals.wireBytes)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
    </div>
  );
}
