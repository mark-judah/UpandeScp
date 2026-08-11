/**
 * UOM display helpers.
 *
 * Stock is always held in the item's stock UOM (a Bin row for a bottle-stocked
 * item is a bottle count). When an operator has chosen to work in grams, the
 * available figure has to be shown in grams too — otherwise "50" next to a
 * gram-denominated rate reads as 50 g when it is really 25,000 g.
 *
 * Every factor comes from ERPNext's own UOM Conversion Detail rows on the Item;
 * nothing here knows what a bottle is.
 */

export interface UomOption {
  uom: string;
  /** ERPNext convention: stock-UOM quantity per 1 of this UOM. */
  conversion_factor: number;
}

/** Factor for `uom`, or 1 when it isn't one the item allows. */
export function factorFor(uoms: UomOption[] | undefined, uom?: string): number {
  if (!uoms?.length || !uom) return 1;
  const hit = uoms.find((u) => u.uom === uom);
  const f = Number(hit?.conversion_factor);
  return Number.isFinite(f) && f > 0 ? f : 1;
}

/**
 * Convert a quantity held in the STOCK UOM into `uom`.
 *
 * Divides by the factor, because the factor counts stock UOM per 1 of `uom`:
 * 50 bottles with Gram at 0.002 → 50 / 0.002 = 25,000 g.
 */
export function fromStockQty(
  stockQty: number,
  uoms: UomOption[] | undefined,
  uom?: string,
): number {
  const q = Number(stockQty);
  if (!Number.isFinite(q)) return 0;
  return q / factorFor(uoms, uom);
}

/** Convert a quantity expressed in `uom` into the stock UOM. */
export function toStockQty(
  qty: number,
  uoms: UomOption[] | undefined,
  uom?: string,
): number {
  const q = Number(qty);
  if (!Number.isFinite(q)) return 0;
  return q * factorFor(uoms, uom);
}

/** Compact display: trims trailing zeros, keeps large numbers readable. */
export function fmtQty(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString();
  const r = Math.round(v * 100) / 100;
  return String(r);
}
