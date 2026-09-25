/** Deriving each chemical's total quantity from its per-1000 L rate.
 *
 * A BOM ships rates "per 1000 L". What the store must actually issue is that
 * rate scaled by the water volume the plan will use, and that total is never
 * typed by the operator — it is always derived here, from
 * ``rate × waterVolume / 1000``.
 *
 * This lives outside ApplicationPlan because the component runs it from an
 * effect that also depends on the rows it writes back. Returning the SAME
 * array when nothing changed is therefore not an optimisation but a
 * correctness requirement: a fresh array every pass would retrigger that
 * effect forever.
 */

/** Litres per hectare, and the basis a BOM's rates are quoted against. */
export const WATER_VOLUME_RATE = 1000;

export interface RateRow {
  /** Operator-editable per-1000 L rate, seeded from the BOM. */
  rate?: number;
  /** Derived total for this spray. Rows arrive at 0 and are filled in here. */
  stock_qty?: number;
}

/**
 * Fill in every row's derived total for the given water volume.
 *
 * Returns ``rows`` itself when no value moved, so the caller can depend on the
 * rows without looping. A row with no rate is left alone: it has nothing to
 * scale, and zeroing it would wipe a total another path just wrote.
 */
export function applyWaterVolume<T extends RateRow>(
  rows: T[],
  waterVolume: string | number,
): T[] {
  const wv = typeof waterVolume === "number" ? waterVolume : parseFloat(waterVolume) || 0;
  if (wv <= 0) return rows;
  const ratio = wv / WATER_VOLUME_RATE;

  let changed = false;
  const next = rows.map((row) => {
    const rate = Number(row.rate ?? 0);
    if (!rate) return row;
    const qty = Math.round(rate * ratio * 10000) / 10000;
    if (qty === row.stock_qty) return row;
    changed = true;
    return { ...row, stock_qty: qty };
  });
  return changed ? next : rows;
}
