"""What each store actually holds, batch by batch.

The one query behind every batch decision in the group. Spray transfers ask it
from the store page, where a person picks; feed manufacture asks it from the
engine, where nothing does. Both need the same answer and neither should grow
its own version of this join, because the join is the part with the traps in it.

Stock here lives in Serial and Batch Bundles — on live, 76,358 ledger entries
carry a bundle against 52 still on the old `batch_no` column — so availability
is the bundle sum per batch and warehouse. Anything netting to zero or less is
dropped: that is history, not stock.

One query per document, not one per row. The alternative, ERPNext's
`get_available_batches`, answers for a single item at a time, and a thirty-line
transfer would become thirty round trips on a page somebody is standing at.
"""

import frappe


ZERO_EPS = 1e-6


def effective_valuation(batchwise, qty_net, value_net, qty_in, value_in, avg_rate) -> dict:
    """The rate ERPNext WILL use when this batch is issued, and whether it is usable.

    * a batch on batch-wise valuation (``use_batchwise_valuation = 1``) is priced at its
      OWN value in the store: stock value / quantity over what it holds. A batch drawn
      to nothing is judged by what it came in at. Zero or negative value is invalid.
    * a batch NOT on batch-wise valuation is priced at the ITEM's moving average in the
      store (``avg_rate``): the batch's own value does not matter. Invalid only when
      that average is zero or negative.

    Returns ``{"method": "batchwise" | "moving_average", "rate": float, "invalid": bool}``.
    """
    if batchwise:
        q, v = float(qty_net or 0), float(value_net or 0)
        if q <= ZERO_EPS:
            q, v = float(qty_in or 0), float(value_in or 0)
        if q <= ZERO_EPS:
            return {"method": "batchwise", "rate": 0.0, "invalid": False}  # nothing on record
        return {"method": "batchwise", "rate": v / q, "invalid": v <= ZERO_EPS}
    rate = float(avg_rate or 0)
    return {"method": "moving_average", "rate": rate, "invalid": rate <= ZERO_EPS}


def _valuation_context(items, houses, batches) -> tuple:
    """({batch: batchwise?}, {(item, warehouse): moving-average rate})."""
    batchwise = {
        r.name: bool(r.use_batchwise_valuation)
        for r in frappe.get_all(
            "Batch", filters={"name": ["in", sorted(batches)]},
            fields=["name", "use_batchwise_valuation"],
        )
    } if batches else {}
    avg = {
        (r.item_code, r.warehouse): float(r.valuation_rate or 0)
        for r in frappe.get_all(
            "Bin",
            filters={"item_code": ["in", sorted(items)], "warehouse": ["in", sorted(houses)]},
            fields=["item_code", "warehouse", "valuation_rate"],
        )
    } if items and houses else {}
    return batchwise, avg


def _ledger_values(items, batches, houses) -> dict:
    """{(item, batch, warehouse): (qty_net, value_net, qty_in, value_in)} from the bundles."""
    rows = frappe.db.sql(
        """
        SELECT sle.item_code, sbe.batch_no, sbe.warehouse,
               SUM(sbe.qty) AS q, SUM(sbe.stock_value_difference) AS v,
               SUM(IF(sbe.qty > 0, sbe.qty, 0))                    AS qi,
               SUM(IF(sbe.qty > 0, sbe.stock_value_difference, 0)) AS vi
        FROM   `tabStock Ledger Entry` sle
        JOIN   `tabSerial and Batch Entry` sbe
               ON sbe.parent = sle.serial_and_batch_bundle
        WHERE  sle.is_cancelled = 0
          AND  sle.item_code IN %(items)s
          AND  sbe.batch_no IN %(batches)s
          AND  sbe.warehouse IN %(houses)s
        GROUP  BY sle.item_code, sbe.batch_no, sbe.warehouse
        """,
        {"items": sorted(items), "batches": sorted(batches), "houses": sorted(houses)},
        as_dict=True,
    )
    return {(r.item_code, r.batch_no, r.warehouse): (r.q, r.v, r.qi, r.vi) for r in rows}


def batch_valuations(triples) -> dict:
    """``{(item_code, batch_no, warehouse): {method, rate, invalid}}`` for those batches,
    by the rule in `effective_valuation`. Independent of what is left in the batch. A
    batch with no entry on record is not reported."""
    triples = {t for t in (triples or []) if t[0] and t[1] and t[2]}
    if not triples:
        return {}
    items = {t[0] for t in triples}
    batches = {t[1] for t in triples}
    houses = {t[2] for t in triples}
    led = _ledger_values(items, batches, houses)
    batchwise, avg = _valuation_context(items, houses, batches)
    out = {}
    for t in triples:
        if t not in led:
            continue
        q, v, qi, vi = led[t]
        out[t] = effective_valuation(
            batchwise.get(t[1], True), q, v, qi, vi, avg.get((t[0], t[2]))
        )
    return out


def zero_valued_batches(triples) -> set:
    """Which ``(item_code, batch_no, warehouse)`` ERPNext would value at zero or less
    when issued (see `effective_valuation`) — the ones that must not be issued."""
    return {t for t, val in batch_valuations(triples).items() if val["invalid"]}


def zero_valued_stock(limit: int = 500) -> list:
    """Every batch that still holds stock but cannot be valued, for the store's
    read-only "fix these" list: ``[{item_code, item_name, batch_no, warehouse, qty,
    method, rate}]`` — ``method`` says which rule priced it (batch-wise or moving average)."""
    held = frappe.db.sql(
        """
        SELECT sle.item_code, sbe.batch_no, sbe.warehouse, SUM(sbe.qty) AS qty
        FROM   `tabStock Ledger Entry` sle
        JOIN   `tabSerial and Batch Entry` sbe
               ON sbe.parent = sle.serial_and_batch_bundle
        WHERE  sle.is_cancelled = 0
        GROUP  BY sle.item_code, sbe.batch_no, sbe.warehouse
        HAVING SUM(sbe.qty) > 0
        """,
        as_dict=True,
    )
    vals = batch_valuations({(r.item_code, r.batch_no, r.warehouse) for r in held})
    names = {
        r.name: r.item_name
        for r in frappe.get_all("Item", filters={"name": ["in", sorted({r.item_code for r in held})]},
                                fields=["name", "item_name"])
    } if held else {}
    out = []
    for r in held:
        v = vals.get((r.item_code, r.batch_no, r.warehouse))
        if v and v["invalid"]:
            out.append({
                "item_code": r.item_code, "item_name": names.get(r.item_code) or r.item_code,
                "batch_no": r.batch_no, "warehouse": r.warehouse, "qty": float(r.qty or 0),
                "method": v["method"], "rate": round(v["rate"], 4),
            })
    out.sort(key=lambda x: (x["warehouse"], x["item_code"], x["batch_no"]))
    return out[:limit]


def available_in_store(pairs: list) -> dict:
    """`{(item_code, warehouse): [batch rows]}` for every pair on the transfer.

    Stock here is held as Serial and Batch Bundles — 76,358 ledger entries
    carry a bundle against 52 that still use the old `batch_no` column — so
    availability is the bundle join, summed per batch and warehouse. Anything
    that nets to zero or less is dropped: it is not stock, it is history.

    One query for the whole transfer. The alternative, ERPNext's
    `get_available_batches`, answers for a single item at a time and would turn
    a thirty-line transfer into thirty round trips on a page someone is waiting
    at.
    """
    if not pairs:
        return {}
    items = sorted({p[0] for p in pairs})
    houses = sorted({p[1] for p in pairs if p[1]})
    if not items or not houses:
        return {}

    rows = frappe.db.sql(
        """
        SELECT sle.item_code, sbe.warehouse, sbe.batch_no,
               SUM(sbe.qty)      AS qty,
               SUM(IF(sbe.qty > 0, sbe.qty, 0))                    AS qty_in,
               SUM(IF(sbe.qty > 0, sbe.stock_value_difference, 0)) AS value_in,
               SUM(sbe.stock_value_difference)                     AS value_net,
               bt.expiry_date    AS expiry_date,
               MIN(bt.creation)  AS created
        FROM   `tabStock Ledger Entry` sle
        JOIN   `tabSerial and Batch Entry` sbe
               ON sbe.parent = sle.serial_and_batch_bundle
        JOIN   `tabBatch` bt ON bt.name = sbe.batch_no
        WHERE  sle.is_cancelled = 0
          AND  bt.disabled = 0
          AND  sle.item_code IN %(items)s
          AND  sbe.warehouse IN %(houses)s
        GROUP  BY sle.item_code, sbe.warehouse, sbe.batch_no, bt.expiry_date
        HAVING SUM(sbe.qty) > 0
        """,
        {"items": items, "houses": houses},
        as_dict=True,
    )

    batchwise, avg = _valuation_context(
        {r["item_code"] for r in rows}, {r["warehouse"] for r in rows},
        {r["batch_no"] for r in rows},
    )
    out: dict = {}
    for r in rows:
        val = effective_valuation(
            batchwise.get(r["batch_no"], True), r["qty"], r["value_net"],
            r["qty_in"], r["value_in"], avg.get((r["item_code"], r["warehouse"])),
        )
        out.setdefault((r["item_code"], r["warehouse"]), []).append(
            {
                "batch_no": r["batch_no"],
                "qty": float(r["qty"] or 0),
                "expiry_date": r["expiry_date"],
                "created": r["created"],
                # Whether ERPNext's own rate for it is usable (see effective_valuation).
                # Invalid means the Manufacture later could not be costed.
                "zero_valued": val["invalid"],
                "valuation_method": val["method"],
            }
        )
    return out
