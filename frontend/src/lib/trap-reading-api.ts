import { call } from "@/lib/frappe";

/** The latest reading at one trap in a window, with the scout who recorded it
 *  (spec 2026-10-11 TM4). `entry` is null when the trap has no reading. */
export interface TrapReading {
  trap: string;
  entry: string | null;
  scout?: string;
  scoutName?: string;
  /** Employee.image — initials only when empty. */
  image?: string;
  date?: string;
  time?: string;
  count?: number;
  pest?: string;
  house?: string;
}

export const TRAP_READING_METHOD =
  "upande_scp.serverscripts.traps.trap_reading.get_latest_trap_reading";

export async function fetchLatestTrapReading(
  trap: string,
  from_date?: string,
  to_date?: string,
): Promise<TrapReading> {
  const r = await call<{ message?: TrapReading } | TrapReading>(TRAP_READING_METHOD, {
    trap,
    from_date: from_date || "",
    to_date: to_date || "",
  });
  return ((r as { message?: TrapReading })?.message ?? r) as TrapReading;
}

/** One photo taken with a trap's catch (`trap_photos`). */
export interface TrapPhoto {
  image: string;
  entry: string;
  scout: string;
  scout_name: string;
  /** Employee.image — initials only when empty. */
  scout_image?: string;
  count: number;
  pest: string;
  date: string;
  time: string;
}

export const TRAP_PHOTOS_METHOD = "upande_scp.serverscripts.traps.trap_reading.trap_photos";

export async function fetchTrapPhotos(
  trap: string,
  from_date?: string,
  to_date?: string,
): Promise<TrapPhoto[]> {
  const r = await call<{ message?: TrapPhoto[] } | TrapPhoto[]>(TRAP_PHOTOS_METHOD, {
    trap,
    from_date: from_date || "",
    to_date: to_date || "",
  });
  const out = (r as { message?: TrapPhoto[] })?.message ?? r;
  return Array.isArray(out) ? out : [];
}
