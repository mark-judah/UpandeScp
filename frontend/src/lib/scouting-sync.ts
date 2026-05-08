/**
 * Scouting cache orchestrator.
 *
 *  - First read: fetch months we don't already have in IDB from L1
 *    (getScoutingEntriesChunk).
 *  - Background: delta sync via L2 (get_entries_since) advances the watermark.
 *  - Realtime nudges from L4 invalidate a single month and re-run delta.
 *
 * Filtering by greenhouse / farm / crop happens *after* IDB reads, never on
 * the server side — see docs/data_caching.md (L1 keys section).
 */

import { call } from "./frappe";
import {
  putEntries,
  getEntriesInRange,
  monthOf,
  getMeta,
  setMeta,
  evictOldMonths,
  type IdbEntry,
} from "./idb";

const META_LOADED_MONTHS = "loaded_months";
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

function monthsBetween(from: string, to: string): string[] {
  if (!from || !to) return [];
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  const out: string[] = [];
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return {
    from: `${month}-01`,
    to: `${month}-${String(last).padStart(2, "0")}`,
  };
}

async function loadedMonthsSet(): Promise<Set<string>> {
  const v = (await getMeta<string[]>(META_LOADED_MONTHS)) || [];
  return new Set(v);
}

async function markMonthLoaded(month: string): Promise<void> {
  const set = await loadedMonthsSet();
  set.add(month);
  await setMeta(META_LOADED_MONTHS, Array.from(set));
}

/**
 * Make sure every month touching [from, to] is fully present in IDB.
 * Skips months we've already fully loaded (the loaded_months registry).
 *
 * `onProgress` is called with `(loaded, total, currentMonth)` after each
 * month resolves so callers can drive a progress bar instead of seeing the
 * value pinned at 10% during a multi-month first-paint download.
 */
export async function hydrateRange(
  from: string,
  to: string,
  onProgress?: (loaded: number, total: number, month: string) => void,
): Promise<void> {
  const months = monthsBetween(monthOf(from), monthOf(to));
  const known = await loadedMonthsSet();
  const missing = months.filter((m) => !known.has(m));

  if (!missing.length) return;

  for (let i = 0; i < missing.length; i++) {
    const m = missing[i];
    const { from: mFrom, to: mTo } = monthBounds(m);
    try {
      const resp = await call<ChunkResp>(
        "upande_scp.serverscripts.get_complete_scouting_entries.getScoutingEntriesChunk",
        {
          from_date: mFrom,
          to_date: mTo,
          include_meta: 0,
        },
      );
      const entries = resp?.entries || [];
      if (entries.length) await putEntries(entries);
      await markMonthLoaded(m);
    } catch (err) {
      console.error("[scouting-sync] hydrate month failed", m, err);
      throw err;
    }
    onProgress?.(i + 1, missing.length, m);
  }
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
      "upande_scp.serverscripts.get_complete_scouting_entries.get_entries_since",
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
 * block, or crop in-memory. This is the single read path used by every
 * page; nothing else queries IDB directly.
 */
export async function readEntries(
  from: string,
  to: string,
  filters: { greenhouse?: string; block?: string; crop?: string } = {},
): Promise<IdbEntry[]> {
  let rows = await getEntriesInRange(from, to);
  const { greenhouse, block, crop } = filters;
  if (greenhouse) rows = rows.filter((r) => r.greenhouse === greenhouse);
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
 * Drop one month from the local cache so the next read re-fetches it.
 * Used by the realtime "scp:scouting:dirty" listener.
 */
export async function invalidateMonth(month: string | null): Promise<void> {
  const known = await loadedMonthsSet();
  if (month) {
    known.delete(month);
  } else {
    known.clear();
  }
  await setMeta(META_LOADED_MONTHS, Array.from(known));
}
