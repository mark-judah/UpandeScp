/**
 * Freshness of chemical-store stock, as one of four bands.
 *
 * Two signals, whichever is worse wins:
 *   - days to expiry, from the nearest live Batch expiry of the item
 *   - age on the shelf, from the FIFO cohorts (how long the oldest stock still
 *     here has been here)
 */
import type { StockBatch } from "@/lib/spray-plan-creator-api";

export type FreshnessBand = "fresh" | "ageing" | "near" | "expired";

/** Expiry within this many days: "Near expiry". */
export const NEAR_EXPIRY_DAYS = 30;
/** Expiry within this many days: "Ageing". */
export const AGEING_EXPIRY_DAYS = 90;
/** Oldest stock on the shelf at least this many days: "Ageing". */
export const AGEING_AGE_DAYS = 180;

export function freshnessBand(input: {
  daysToExpiry: number | null | undefined;
  oldestAgeDays: number | null | undefined;
}): FreshnessBand {
  const d = input.daysToExpiry;
  if (d != null) {
    if (d < 0) return "expired";
    if (d <= NEAR_EXPIRY_DAYS) return "near";
  }
  if (d != null && d <= AGEING_EXPIRY_DAYS) return "ageing";
  if ((input.oldestAgeDays ?? 0) >= AGEING_AGE_DAYS) return "ageing";
  return "fresh";
}

/** Nearest expiry across an item's batches, or null when none carries one. */
export function nearestExpiryDays(batches: StockBatch[] | undefined): number | null {
  let best: number | null = null;
  for (const b of batches ?? []) {
    if (b.days_to_expiry == null) continue;
    if (best === null || b.days_to_expiry < best) best = b.days_to_expiry;
  }
  return best;
}

/** Calm sequential scale: light neutral -> muted amber -> muted terracotta.
 *  Dark ink text reads on all four; nothing saturated. */
export const BAND_STYLE: Record<
  FreshnessBand,
  { label: string; rule: string; fill: string; edge: string }
> = {
  fresh: {
    label: "Fresh",
    rule: `expiry beyond ${AGEING_EXPIRY_DAYS} days and on the shelf under ${AGEING_AGE_DAYS} days`,
    fill: "#ebe8df",
    edge: "#d6d2c5",
  },
  ageing: {
    label: "Ageing",
    rule: `expiry within ${AGEING_EXPIRY_DAYS} days, or on the shelf ${AGEING_AGE_DAYS}+ days`,
    fill: "#e6d4a4",
    edge: "#d2bd84",
  },
  near: {
    label: "Near expiry",
    rule: `expires within ${NEAR_EXPIRY_DAYS} days`,
    fill: "#dcaa92",
    edge: "#c8927a",
  },
  expired: {
    label: "Expired",
    rule: "past its expiry date",
    fill: "#c58b84",
    edge: "#b0736c",
  },
};

export const BAND_ORDER: FreshnessBand[] = ["fresh", "ageing", "near", "expired"];
