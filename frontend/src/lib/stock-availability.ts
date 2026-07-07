/**
 * Draft-aware available stock for the Application Plan chemical matrix.
 *
 * ``onHand`` is the raw warehouse balance (e.g. from ``get_bom_details``'s
 * ``balances``). ``reservedFromServer`` is the sum of other still-open
 * Application Floor Plan work orders drawing from the same warehouse+item
 * (``get_store_reservations``). ``draftFormUsage`` is the sum of ``stock_qty``
 * for *other* rows in the *current* form that share the same item + source —
 * catches the case where the operator adds the same chemical twice in one
 * plan before it's ever saved as a draft.
 *
 * All three inputs are optional / may be missing or non-numeric; missing
 * treated as 0. Never returns negative — floors at 0 so the UI can't show
 * "-3 available" and confuse the operator.
 */
export function availableStock(opts: {
  onHand?: number;
  reservedFromServer?: number;
  draftFormUsage?: number;
}): number {
  const onHand = Number(opts.onHand || 0);
  const reserved = Number(opts.reservedFromServer || 0);
  const draft = Number(opts.draftFormUsage || 0);
  return Math.max(0, onHand - reserved - draft);
}
