/**
 * Cumulative per-hectare figures for block-grown crops (avocado).
 *
 * An orchard block is too large to scout in one pass, so a block is judged on
 * its whole scouting round: the cumulative count of a pest over the round,
 * divided by the block's area in hectares. Never "per tree". The server does
 * the arithmetic (cumulative_per_ha.get_round_per_ha); the browser formats it.
 */
import { call } from "./frappe";

const NS = "upande_scp.serverscripts.scouting.cumulative_per_ha";

export interface PerHaDay {
  date: string;
  count: number;
  running: number;
}

export interface PerHaObservation {
  block: string;
  farm: string;
  kind: "pest" | "disease";
  observation: string;
  cumulative: number;
  area_ha: number | null;
  per_ha: number | null;
  /** 0 = no cumulative threshold configured */
  threshold_per_ha: number;
  crossed_on: string | null;
  daily: PerHaDay[];
  scouts: string[];
}

export interface PerHaBlock {
  block: string;
  farm: string;
  area_ha: number | null;
  scouted: boolean;
  observations: PerHaObservation[];
}

export interface PerHaSummary {
  kind: "pest" | "disease";
  observation: string;
  cumulative: number;
  area_ha: number;
  per_ha: number | null;
  blocks: number;
  worst: { block: string; per_ha: number | null } | null;
  threshold_per_ha?: number;
  blocks_over?: number;
}

export interface RoundPerHa {
  crop: string;
  round: { start: string; end: string; days: number; label: string };
  blocks: PerHaBlock[];
  summary: PerHaSummary[];
  /** Blocks with no area set: no per-ha figure can be shown for them. */
  no_area: string[];
}

/** 12.4 from 10 up, 0.46 below: a block of several hectares with a handful of
 *  pests lives in the fractions. Matches the alert email. */
export function formatPerHa(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const v = Math.round(value * 100) / 100;
  return Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/** "12.4 / ha" */
export function perHaLabel(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${formatPerHa(value)} / ha`;
}

/** "12.4 / ha (cumulative this round)" */
export function perHaLongLabel(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "— (no block area)"
    : `${perHaLabel(value)} (cumulative this round)`;
}

export function fetchRoundPerHa(
  crop: string,
  opts: { farm?: string; block?: string; day?: string } = {},
): Promise<RoundPerHa> {
  return call<RoundPerHa>(`${NS}.get_round_per_ha`, { crop, ...opts });
}

export function previewCumulativeAlertEmail(crop: string, block?: string): Promise<string> {
  return call<string>(`${NS}.preview_cumulative_alert_email`, { crop, block });
}

export function sendTestCumulativeAlert(
  crop: string,
  block?: string,
): Promise<{ sent: boolean; to?: string; reason?: string }> {
  return call(`${NS}.send_test_cumulative_alert`, { crop, block });
}
