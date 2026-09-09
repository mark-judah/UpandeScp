/**
 * The pure parts of the "awaiting GM approval" section.
 *
 * The store keeper's Transfers page only ever showed work they could act on,
 * because the draft transfer they issue against is created at the moment of
 * approval. Everything still waiting on the General Manager was invisible —
 * hundreds of plans, and no warning that the chemicals would be wanted. This
 * module holds the small decisions that section makes about presenting that
 * work, kept out of the component so they can be read and tested on their own.
 */

export interface PlannedTotal {
  item_code: string;
  item_name: string;
  uom: string;
  total_qty: number;
}

export interface PlannedRow {
  work_order: string;
  planned_date: string | null;
  greenhouse: string;
  farm: string;
  item_count: number;
  total_qty: number;
}

export interface PlannedItem {
  item_code: string;
  item_name: string;
  qty: number;
  uom: string;
  from_warehouse: string;
}

/**
 * The head of the demand list, plus how much was left off.
 *
 * A keeper reading the strip is deciding what to carry, and fifty chemicals is
 * not a decision — but the tail must be acknowledged rather than dropped, or
 * the strip quietly understates the day. The server has already ranked these
 * by quantity; re-sorting here would only create a second opinion about what
 * "biggest" means.
 */
export function topTotals(
  totals: PlannedTotal[],
  limit = 6,
): { shown: PlannedTotal[]; extraCount: number } {
  return {
    shown: totals.slice(0, limit),
    extraCount: Math.max(0, totals.length - limit),
  };
}

/** The one-line description under the section title. */
export function plannedSummary(rows: PlannedRow[]): {
  plans: number;
  totalQty: number;
  label: string;
} {
  const plans = rows.length;
  const totalQty = rows.reduce((sum, r) => sum + (r.total_qty || 0), 0);
  const label =
    plans === 0
      ? "Nothing awaiting approval"
      : `${plans} plan${plans === 1 ? "" : "s"} awaiting the General Manager`;
  return { plans, totalQty, label };
}

/**
 * The day a plan is due to be sprayed. The store works in days, and a
 * timestamp in a table column is just noise to read past.
 */
export function plannedDay(value: string | null | undefined): string {
  if (!value) return "—";
  return String(value).slice(0, 10);
}
