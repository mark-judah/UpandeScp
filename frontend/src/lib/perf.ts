/**
 * Tiny client-side performance recorder for the SCP React frontend.
 *
 * `call()` in `frappe.ts` reports every request here. We keep:
 *  - a bounded ring buffer of the last N calls, and
 *  - a running per-method aggregate (count, total fetch/parse ms, total
 *    wire/decoded bytes) used to render the endpoint breakdown, worst first.
 *
 * Byte accounting comes from the Resource Timing API
 * (`PerformanceResourceTiming.encodedBodySize` / `decodedBodySize`), NOT
 * `text.length`. `encodedBodySize` is what actually crossed the wire
 * (post-gzip); `decodedBodySize` is what the browser inflated and handed to
 * `JSON.parse`. That distinction is the whole point of this instrument: it
 * proves compression is working, and shows that parse cost tracks the
 * *decoded* size, which gzip does nothing to reduce. `text.length` is a
 * UTF-16 character count — not either of those — and is used only as a
 * last-resort fallback when no matching timing entry exists (cross-origin,
 * or the browser's resource-timing buffer having rolled the entry off).
 *
 * No React here, no external deps — components `subscribe()` to re-render.
 */

export interface PerfEntry {
  method: string;
  ts: number; // performance.now() when the call was recorded
  fetchMs: number;
  parseMs: number;
  wireBytes: number; // encodedBodySize — compressed, on the wire
  rawBytes: number; // decodedBodySize — decompressed, what JSON.parse saw
}

export interface MethodAgg {
  method: string;
  count: number;
  fetchMs: number;
  parseMs: number;
  wireBytes: number;
  rawBytes: number;
}

export interface PerfTotals {
  count: number;
  fetchMs: number;
  parseMs: number;
  wireBytes: number;
  rawBytes: number;
}

const RING_SIZE = 100;
const ring: PerfEntry[] = [];
const totals: PerfTotals = {
  count: 0,
  fetchMs: 0,
  parseMs: 0,
  wireBytes: 0,
  rawBytes: 0,
};
const byMethod = new Map<string, MethodAgg>();

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe to "a call was recorded". Returns an unsubscribe function. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) fn();
}

/** Trim a dotted Frappe method path to its last two segments for display,
 *  e.g. `upande_scp.api.scouting.get_beds_and_zones` -> `scouting.get_beds_and_zones`. */
export function shortMethod(method: string): string {
  const parts = method.split(".");
  return parts.length <= 2 ? method : parts.slice(-2).join(".");
}

function sizesFor(
  url: string,
  text: string,
  fetchStart: number,
): { wireBytes: number; rawBytes: number } {
  try {
    const entries = performance.getEntriesByName(
      url,
    ) as PerformanceResourceTiming[];
    // Prefer the entry that started at/after our own fetch began, to avoid
    // picking up a concurrent call to the same method. Fall back to the most
    // recent entry for the URL if none matches.
    const entry =
      entries.find((e) => e.startTime >= fetchStart - 1) ??
      entries[entries.length - 1];
    if (entry && (entry.encodedBodySize > 0 || entry.decodedBodySize > 0)) {
      return {
        wireBytes: entry.encodedBodySize,
        rawBytes: entry.decodedBodySize,
      };
    }
  } catch {
    // Resource Timing unavailable — fall through to the text-length fallback.
  }
  const len = text.length;
  return { wireBytes: len, rawBytes: len };
}

/**
 * Record one completed `call()`. Never throws — a perf-recording bug must
 * never take down a real request.
 */
export function recordCall(
  method: string,
  url: string,
  text: string,
  fetchStart: number,
  fetchMs: number,
  parseMs: number,
): void {
  try {
    const { wireBytes, rawBytes } = sizesFor(url, text, fetchStart);
    const entry: PerfEntry = {
      method,
      ts: performance.now(),
      fetchMs,
      parseMs,
      wireBytes,
      rawBytes,
    };

    ring.push(entry);
    if (ring.length > RING_SIZE) ring.shift();

    totals.count += 1;
    totals.fetchMs += fetchMs;
    totals.parseMs += parseMs;
    totals.wireBytes += wireBytes;
    totals.rawBytes += rawBytes;

    const agg = byMethod.get(method) ?? {
      method,
      count: 0,
      fetchMs: 0,
      parseMs: 0,
      wireBytes: 0,
      rawBytes: 0,
    };
    agg.count += 1;
    agg.fetchMs += fetchMs;
    agg.parseMs += parseMs;
    agg.wireBytes += wireBytes;
    agg.rawBytes += rawBytes;
    byMethod.set(method, agg);

    notify();
  } catch {
    // Swallow — instrumentation must never break the caller.
  }
}

/** Last `RING_SIZE` recorded calls, oldest first. */
export function getEntries(): PerfEntry[] {
  return ring.slice();
}

/** Running totals across the whole session (not bounded by the ring). */
export function getTotals(): PerfTotals {
  return { ...totals };
}

/** Per-endpoint breakdown, slowest first (total fetch+parse ms). */
export function getByMethod(): MethodAgg[] {
  return Array.from(byMethod.values()).sort(
    (a, b) => b.fetchMs + b.parseMs - (a.fetchMs + a.parseMs),
  );
}

/** Wall-clock ms since navigation start. `performance.now()` is already
 *  relative to `performance.timeOrigin`, so no bookkeeping is needed. */
export function getSessionElapsedMs(): number {
  return performance.now();
}

const STORAGE_KEY = "scp:perf";

/**
 * Opt-in flag. `?perf=1` in the URL enables and persists the choice to
 * localStorage; `?perf=0` disables and persists that too. Absent the query
 * param, the persisted choice (default: hidden) wins.
 */
export function isPerfEnabled(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("perf");
    if (q === "1") {
      localStorage.setItem(STORAGE_KEY, "1");
      return true;
    }
    if (q === "0") {
      localStorage.setItem(STORAGE_KEY, "0");
      return false;
    }
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 2)} ${units[i]}`;
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0 ms";
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m <= 0 ? `${s}s` : `${m}m ${s}s`;
}
