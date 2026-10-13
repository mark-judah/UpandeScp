/**
 * Re-entry board endpoints.
 * Backend: upande_scp.serverscripts.spray_plan_creator.reentry
 * Farm and crop scoping, and the role check, are enforced server-side.
 */
import { call } from "./frappe";

const API = "upande_scp.serverscripts.spray_plan_creator.reentry";

export type EntryStatus = "no_entry" | "harvest_held" | "clear";

export interface HouseEntry {
  house: string;
  house_label: string;
  farm: string;
  status: EntryStatus;
  /** spray end + the longest re-entry interval in the mix */
  reentry_time: string | null;
  /** spray end + the longest pre-harvest interval; null when there is none */
  harvest_after: string | null;
  work_order: string;
  ended_at: string;
  /** when the house became clear; null unless status is "clear" */
  cleared_at: string | null;
  products: string[];
}

export interface EntryBoard {
  /** the server's clock, "YYYY-MM-DD HH:MM:SS[.ffffff]" */
  now: string;
  houses: HouseEntry[];
}

export function fetchEntryBoard(crop?: string, farm?: string): Promise<EntryBoard> {
  return call<EntryBoard>(`${API}.get_entry_board`, { crop: crop || undefined, farm: farm || undefined });
}

/** Frappe's naive datetime string as a Date in the browser's own zone. */
export function parseServerTime(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "3 h 12 min", "45 min", "2 d 4 h" — time remaining, rounded up to the minute. */
export function formatRemaining(ms: number): string {
  const mins = Math.max(0, Math.ceil(ms / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return h ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}
