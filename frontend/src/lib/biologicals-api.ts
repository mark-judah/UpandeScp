/**
 * Biologicals page endpoints (predator releases and expected mortality).
 * Backend: upande_scp.serverscripts.biologicals.release / .mortality.
 * Roses only for now; a supervisor sees the farms they are rostered on.
 */
import { call } from "./frappe";

const REL = "upande_scp.serverscripts.biologicals.release";
const MORT = "upande_scp.serverscripts.biologicals.mortality";

export interface ReleaseRow {
  name: string;
  released_at: string;
  greenhouse: string;
  farm: string | null;
  predator: string;
  stage: string | null;
  quantity: number;
  uom: string;
  item: string | null;
  batch_no: string | null;
  store: string | null;
  released_by_name: string | null;
  stock_entry: string | null;
  notes: string | null;
}

export interface ReleasesPayload {
  rows: ReleaseRow[];
  by_predator: { predator: string; uom: string; quantity: number }[];
  by_greenhouse: { greenhouse: string; quantity: number }[];
  filters: { greenhouses: string[]; predators: string[] };
}

export interface ReleaseFilters {
  from_date?: string;
  to_date?: string;
  greenhouse?: string;
  predator?: string;
  farm?: string;
}

export interface MortalityRow {
  wo: string;
  when: string;
  greenhouse: string;
  predator: string;
  present: number;
  mortality_pct: number;
  expected_kill: number;
  uom: string;
  products: string[];
}

export interface MortalityPayload {
  label: string;
  from_date: string;
  to_date: string;
  presence_days: number;
  rows: MortalityRow[];
  by_predator: Record<string, number>;
  by_greenhouse: Record<string, number>;
  total: number;
}

export const fetchReleases = (f: ReleaseFilters) =>
  call<ReleasesPayload>(`${REL}.list_releases`, { ...f });

export const fetchMortality = (f: ReleaseFilters) =>
  call<MortalityPayload>(`${MORT}.mortality_report`, { ...f, crop: "Rose" });

/** "2026-11-05 08:00:00" -> "5 Nov 08:00". */
export function whenLabel(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Quantities are counts of stock units: no trailing zeros. */
export const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ""));
