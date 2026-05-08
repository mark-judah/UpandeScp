/**
 * Minimal IndexedDB wrapper for the scouting cache.
 * One database, two stores:
 *   - entries: Scouting Entry rows keyed by `name`, indexed by month/greenhouse/block/modified
 *   - meta:    key/value bag for the sync watermark + loaded-month registry
 *
 * Single source of truth for Dashboard, Trends, and Heatmap. No per-page
 * projections are stored — pages derive views from the flat entry rows.
 *
 * See docs/data_caching.md (L3) for the design contract.
 */

const DB_NAME = "upande_scp";
// v3 — force a clean rehydrate so every cached row carries lat/lng. v2
// added the columns to the IDB schema but pre-existing rows kept their
// pre-v2 shape and the loaded_months registry blocked refetches; the
// traps map needs coordinates on every entry, so on upgrade we drop the
// entries store and clear the loaded_months pointer.
const DB_VERSION = 3;
const STORE_ENTRIES = "entries";
const STORE_META = "meta";

export interface IdbEntry {
  name: string;
  date_of_capture: string;
  modified: string;
  month: string; // YYYY-MM derived from date_of_capture
  greenhouse?: string;
  block?: string;
  crop_scouted?: string;
  latitude?: number;
  longitude?: number;
  // …rest of the entry fields are stored as-is
  [key: string]: unknown;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const oldVersion = (event as IDBVersionChangeEvent).oldVersion || 0;

        // v3: pre-existing rows can lack lat/lng. Drop entries + the
        // loaded_months pointer so the next page load rehydrates cleanly.
        if (oldVersion > 0 && oldVersion < 3) {
          if (db.objectStoreNames.contains(STORE_ENTRIES)) {
            db.deleteObjectStore(STORE_ENTRIES);
          }
          const upgradeTx = req.transaction;
          if (
            upgradeTx &&
            db.objectStoreNames.contains(STORE_META)
          ) {
            try {
              upgradeTx.objectStore(STORE_META).delete("loaded_months");
              upgradeTx.objectStore(STORE_META).delete("watermark");
            } catch {
              // Ignore — the meta keys may not exist yet.
            }
          }
        }

        if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
          const s = db.createObjectStore(STORE_ENTRIES, { keyPath: "name" });
          s.createIndex("month", "month", { unique: false });
          s.createIndex("greenhouse", "greenhouse", { unique: false });
          s.createIndex("block", "block", { unique: false });
          s.createIndex("modified", "modified", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | T,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const req = fn(s);
        if (req && typeof (req as IDBRequest).addEventListener === "function") {
          (req as IDBRequest<T>).onsuccess = () =>
            resolve((req as IDBRequest<T>).result);
          (req as IDBRequest<T>).onerror = () =>
            reject((req as IDBRequest<T>).error);
        } else {
          t.oncomplete = () => resolve(req as T);
          t.onerror = () => reject(t.error);
        }
      }),
  );
}

export function monthOf(date: string): string {
  return (date || "").slice(0, 7);
}

function toCoord(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
}

function normalize(e: Record<string, any>): IdbEntry {
  return {
    ...e,
    name: String(e.name),
    date_of_capture: String(e.date_of_capture || ""),
    modified: String(e.modified || ""),
    month: monthOf(String(e.date_of_capture || "")),
    greenhouse: e.greenhouse || undefined,
    block: e.block || undefined,
    crop_scouted: e.crop_scouted || undefined,
    latitude: toCoord(e.latitude),
    longitude: toCoord(e.longitude),
  };
}

export async function putEntries(entries: Record<string, any>[]): Promise<void> {
  if (!entries.length) return;
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_ENTRIES, "readwrite");
    const s = t.objectStore(STORE_ENTRIES);
    entries.forEach((raw) => s.put(normalize(raw)));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function deleteByName(names: string[]): Promise<void> {
  if (!names.length) return;
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_ENTRIES, "readwrite");
    const s = t.objectStore(STORE_ENTRIES);
    names.forEach((n) => s.delete(n));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getEntriesInRange(
  fromDate: string,
  toDate: string,
): Promise<IdbEntry[]> {
  const months = monthsCovered(fromDate, toDate);
  const db = await open();
  const out: IdbEntry[] = [];
  await Promise.all(
    months.map(
      (m) =>
        new Promise<void>((resolve, reject) => {
          const t = db.transaction(STORE_ENTRIES, "readonly");
          const s = t.objectStore(STORE_ENTRIES);
          const req = s.index("month").getAll(IDBKeyRange.only(m));
          req.onsuccess = () => {
            (req.result as IdbEntry[]).forEach((e) => {
              if (e.date_of_capture >= fromDate && e.date_of_capture <= toDate)
                out.push(e);
            });
            resolve();
          };
          req.onerror = () => reject(req.error);
        }),
    ),
  );
  return out;
}

function monthsCovered(fromDate: string, toDate: string): string[] {
  if (!fromDate || !toDate) return [];
  const out: string[] = [];
  const [fy, fm] = fromDate.split("-").map(Number);
  const [ty, tm] = toDate.split("-").map(Number);
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

/* ---------- meta store ---------- */

export async function getMeta<T = unknown>(key: string): Promise<T | null> {
  const result = await tx<{ key: string; value: T } | undefined>(
    STORE_META,
    "readonly",
    (s) => s.get(key) as IDBRequest,
  );
  return result ? (result.value as T) : null;
}

export async function setMeta<T = unknown>(key: string, value: T): Promise<void> {
  await tx(STORE_META, "readwrite", (s) => s.put({ key, value }) as IDBRequest);
}

/* ---------- eviction ---------- */

const ROLLING_WINDOW_DAYS = 90;

export async function evictOldMonths(): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - ROLLING_WINDOW_DAYS);
  const cutoffMonth = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}`;

  const db = await open();
  return new Promise<number>((resolve, reject) => {
    const t = db.transaction(STORE_ENTRIES, "readwrite");
    const s = t.objectStore(STORE_ENTRIES);
    const idx = s.index("month");
    const range = IDBKeyRange.upperBound(cutoffMonth, true);
    const req = idx.openCursor(range);
    let removed = 0;
    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        cursor.delete();
        removed++;
        cursor.continue();
      }
    };
    t.oncomplete = () => resolve(removed);
    t.onerror = () => reject(t.error);
  });
}

export async function clearAll(): Promise<void> {
  const db = await open();
  await Promise.all(
    [STORE_ENTRIES, STORE_META].map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const t = db.transaction(name, "readwrite");
          t.objectStore(name).clear();
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
        }),
    ),
  );
}
