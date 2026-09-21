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

    out: dict = {}
    for r in rows:
        out.setdefault((r["item_code"], r["warehouse"]), []).append(
            {
                "batch_no": r["batch_no"],
                "qty": float(r["qty"] or 0),
                "expiry_date": r["expiry_date"],
                "created": r["created"],
            }
        )
    return out
