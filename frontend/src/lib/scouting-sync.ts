/**
 * Scouting cache orchestrator.
 *
 *  - First read: fetch ISO weeks we don't already have in IDB from L1
 *    (getScoutingEntriesChunk). All missing weeks fire in parallel so the
 *    operator's wall-clock is bounded by the slowest single week, not the
 *    sum of them.
 *  - Background: delta sync via L2 (get_entries_since) advances the watermark.
 *  - Realtime nudges from L4 invalidate the affected weeks and re-run delta.
 *
 * Filtering by greenhouse / farm / crop happens *after* IDB reads, never on
 * the server side — see docs/data_caching.md (L1 keys section).
 */

import { call } from "./frappe";
import {
  putEntries,
  getEntriesInRange,
  getMeta,
  setMeta,
  evictOldMonths,
  type IdbEntry,
} from "./idb";
import { isoWeek } from "./iso-week";

const META_LOADED_WEEKS = "loaded_weeks";
const META_LOADED_MONTHS_LEGACY = "loaded_months";
const META_WATERMARK = "watermark";

interface ChunkResp {
  entries?: Record<string, any>[];
}

interface DeltaResp {
  server_now: string;
  since: string;
  entries: Record<string, any>[];
  has_more: boolean;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfIsoWeek(d: Date): Date {
  const day = d.getDay() || 7; // Sunday → 7 so Monday becomes the anchor
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  out.setDate(d.getDate() - (day - 1));
  return out;
}

function isoWeekYear(d: Date): number {
  // ISO 8601: the year of the Thursday in the same ISO week.
  const t = new Date(d);
  const day = t.getDay() || 7;
  t.setDate(t.getDate() + 4 - day);
  return t.getFullYear();
}

interface WeekSlot {
  key: string;
  from: string;
  to: string;
}

function weeksBetween(from: string, to: string): WeekSlot[] {
  if (!from || !to || from > to) return [];
  const fromDate = new Date(from + "T00:00:00");
  const toDate = new Date(to + "T00:00:00");
  const out: WeekSlot[] = [];
  let cur = startOfIsoWeek(fromDate);
  while (cur.getTime() <= toDate.getTime()) {
    const sun = new Date(cur);
    sun.setDate(cur.getDate() + 6);
    const wy = isoWeekYear(cur);
    const wn = isoWeek(cur);
    out.push({
      key: `${wy}-W${String(wn).padStart(2, "0")}`,
      from: ymd(cur),
      to: ymd(sun),
    });
    cur = new Date(cur);
    cur.setDate(cur.getDate() + 7);
  }
  return out;
}

async function loadedWeeksSet(): Promise<Set<string>> {
  const v = (await getMeta<string[]>(META_LOADED_WEEKS)) || [];
  return new Set(v);
}

/**
 * The set of ISO weeks touching [from, to] that aren't yet recorded in the
 * loaded-weeks registry. Returns empty when everything is cached — callers
 * can use that to skip the loading state entirely.
 */
export async function getMissingWeeks(
  from: string,
  to: string,
): Promise<WeekSlot[]> {
  const weeks = weeksBetween(from, to);
  if (!weeks.length) return [];
  const known = await loadedWeeksSet();
  return weeks.filter((w) => !known.has(w.key));
}

async function markWeekLoaded(week: string): Promise<void> {
  const set = await loadedWeeksSet();
  set.add(week);
  await setMeta(META_LOADED_WEEKS, Array.from(set));
}

let legacyMonthsCleared = false;
async function clearLegacyMonthsRegistry(): Promise<void> {
  // One-time migration on the first hydrateRange call after deploy. The
  // entries store keeps its data — putEntries upserts — but the old
  // month-granular "fully loaded" registry is no longer trusted.
  if (legacyMonthsCleared) return;
  legacyMonthsCleared = true;
  try {
    const legacy = await getMeta<string[]>(META_LOADED_MONTHS_LEGACY);
    if (legacy) await setMeta(META_LOADED_MONTHS_LEGACY, []);
  } catch {
    // Non-fatal — worst case we re-fetch a few weeks that IDB already has.
  }
}

/**
 * Make sure every ISO week touching [from, to] is fully present in IDB.
 * Skips weeks we've already fully loaded (the loaded_weeks registry).
 *
 * All missing weeks are fetched concurrently. ``onProgress`` is called with
 * ``(loaded, total, weekKey)`` after each week resolves so callers can drive
 * a progress bar.
 */
export async function hydrateRange(
  from: string,
  to: string,
  onProgress?: (loaded: number, total: number, week: string) => void,
): Promise<void> {
  await clearLegacyMonthsRegistry();
  const missing = await getMissingWeeks(from, to);

  if (!missing.length) return;

  let done = 0;
  await Promise.all(
    missing.map(async (w) => {
      try {
        const resp = await call<ChunkResp>(
          "upande_scp.serverscripts.scouting.get_complete_scouting_entries.getScoutingEntriesChunk",
          {
            from_date: w.from,
            to_date: w.to,
            include_meta: 0,
          },
        );
        const entries = resp?.entries || [];
        if (entries.length) await putEntries(entries);
        await markWeekLoaded(w.key);
      } catch (err) {
        console.error("[scouting-sync] hydrate week failed", w.key, err);
        throw err;
      }
      done += 1;
      onProgress?.(done, missing.length, w.key);
    }),
  );
}

/**
 * Pull rows whose ``modified`` is strictly after the watermark. Loops while
 * ``has_more`` is true so a long-paused tab catches up in one go.
 */
export async function runDelta(): Promise<{ added: number; advanced: string }> {
  const since = (await getMeta<string>(META_WATERMARK)) || "";
  let watermark = since;
  let added = 0;
  let safety = 20; // prevent infinite loop on a misbehaving server

  for (;;) {
    const resp = await call<DeltaResp>(
      "upande_scp.serverscripts.scouting.get_complete_scouting_entries.get_entries_since",
      { since: watermark, limit: 2000 },
    );
    const entries = resp?.entries || [];
    if (entries.length) await putEntries(entries);
    added += entries.length;
    watermark = resp?.server_now || watermark;
    if (!resp?.has_more) break;
    if (--safety <= 0) break;
  }

  if (watermark) await setMeta(META_WATERMARK, watermark);
  return { added, advanced: watermark };
}

/**
 * Read entries for [from, to] from IDB. Optionally filter by greenhouse,
 * block, or crop in-memory. ``greenhouses`` accepts a list — pages use
 * that to express "any greenhouse on this farm" without giving up the
 * single read path. This is the single read path used by every page;
 * nothing else queries IDB directly.
 */
export async function readEntries(
  from: string,
  to: string,
  filters: {
    greenhouse?: string;
    greenhouses?: string[];
    block?: string;
    crop?: string;
  } = {},
): Promise<IdbEntry[]> {
  let rows = await getEntriesInRange(from, to);
  const { greenhouse, greenhouses, block, crop } = filters;
  if (greenhouse) {
    rows = rows.filter((r) => r.greenhouse === greenhouse);
  } else if (greenhouses && greenhouses.length) {
    const allow = new Set(greenhouses);
    rows = rows.filter((r) => !!r.greenhouse && allow.has(r.greenhouse));
  }
  if (block) rows = rows.filter((r) => r.block === block);
  if (crop) rows = rows.filter((r) => (r.crop_scouted || "Rose") === crop);
  return rows;
}

/**
 * One-shot priming for first paint: hydrate range, then kick off a delta
 * sync in the background. Resolves as soon as the hydrate step is done so
 * the UI can render without waiting on delta.
 */
export async function primeAndDelta(
  from: string,
  to: string,
): Promise<void> {
  await hydrateRange(from, to);
  // Fire-and-forget delta sync.
  void runDelta().catch(() => {});
  void evictOldMonths().catch(() => {});
}

/**
 * Drop the loaded-weeks pointer for every ISO week touching the last
 * ``daysBack`` days. Called once per dashboard mount so retroactively-synced
 * mobile entries (whose ``modified`` timestamp predates our delta watermark)
 * still show up: the next ``hydrateRange`` call will re-fetch these weeks
 * from the server, picking up any rows the watermark-based delta misses.
 *
 * Server-side per-week payloads are Redis-cached with a version stamp that
 * bumps on every Scouting Entry insert/update, so a re-fetch is a single
 * Redis read on warm cache or one fresh build per modified week. Cheap.
 */
export async function invalidateRecentWeeks(daysBack: number): Promise<void> {
  if (!Number.isFinite(daysBack) || daysBack <= 0) return;
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - daysBack);
  const recent = weeksBetween(ymd(start), ymd(today));
  if (!recent.length) return;
  const known = await loadedWeeksSet();
  recent.forEach((w) => known.delete(w.key));
  await setMeta(META_LOADED_WEEKS, Array.from(known));
}

/**
 * Background freshness pass for the maps/dashboards. Re-fetches the ISO weeks
 * that are BOTH within the last ``daysBack`` days AND inside [from, to],
 * upserting whatever the server returns, then advances the delta watermark.
 *
 * Crucially it does NOT touch the loaded-weeks registry — unlike
 * ``invalidateRecentWeeks`` + ``hydrateRange``. The registry is what the
 * blocking hydrate path keys off; leaving recent weeks marked "loaded" means
 * a map that opens mid-refresh still renders straight from IDB instead of
 * flashing the loading overlay. Callers run this fire-and-forget after first
 * paint.
 *
 * Returns true when any rows were (re)fetched or the delta added rows, so the
 * caller can decide whether a silent re-render is worth it. By the time this
 * runs, every in-range week is already present in IDB (the blocking path
 * hydrates genuinely-missing weeks first), so we only ever *refresh* here.
 */
export async function refreshRecentWeeks(
  from: string,
  to: string,
  daysBack: number,
): Promise<boolean> {
  let touched = false;
  if (Number.isFinite(daysBack) && daysBack > 0 && from && to && from <= to) {
    const today = new Date();
    const start = new Date(today);
    start.setDate(today.getDate() - daysBack);
    const recentKeys = new Set(
      weeksBetween(ymd(start), ymd(today)).map((w) => w.key),
    );
    const weeks = weeksBetween(from, to).filter((w) => recentKeys.has(w.key));
    await Promise.all(
      weeks.map(async (w) => {
        try {
          const resp = await call<ChunkResp>(
            "upande_scp.serverscripts.scouting.get_complete_scouting_entries.getScoutingEntriesChunk",
            { from_date: w.from, to_date: w.to, include_meta: 0 },
          );
          const entries = resp?.entries || [];
          if (entries.length) {
            await putEntries(entries);
            touched = true;
          }
        } catch (err) {
          console.error("[scouting-sync] recent refresh failed", w.key, err);
        }
      }),
    );
  }
  try {
    const { added } = await runDelta();
    if (added > 0) touched = true;
  } catch (err) {
    console.error("[scouting-sync] delta failed", err);
  }
  return touched;
}

/**
 * Drop the loaded-weeks pointer for everything touched by ``month`` so the
 * next hydrate re-fetches those weeks. ``month`` is a "YYYY-MM" string;
 * passing ``null`` clears the entire week registry. Used by the realtime
 * "scp:scouting:dirty" listener which still speaks in month buckets.
 */
export async function invalidateMonth(month: string | null): Promise<void> {
  const known = await loadedWeeksSet();
  if (!month) {
    known.clear();
  } else {
    const [y, m] = month.split("-").map(Number);
    if (!y || !m) return;
    const first = `${month}-01`;
    const last = new Date(y, m, 0).getDate();
    const lastStr = `${month}-${String(last).padStart(2, "0")}`;
    weeksBetween(first, lastStr).forEach((w) => known.delete(w.key));
  }
  await setMeta(META_LOADED_WEEKS, Array.from(known));
}
