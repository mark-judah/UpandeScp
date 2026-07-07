"""Draft-aware reservation math for Application Floor Plan work orders.

Pure helpers (no frappe imports) live at the top so they are unit-testable;
the whitelisted DB endpoint is added in a later task.
"""

RESERVED_EXCLUDED_STATES = {
    "Chemical Issued",
    "Tank Mix Manufactured",
    "Spraying In Progress",
    "Completed",
}


def is_reserved_state(workflow_state, status):
    """True when a work order still reserves source stock (drafted/submitted,
    not yet material-issued, not stopped)."""
    if status == "Stopped":
        return False
    state = workflow_state or "Pending Submission"
    return state not in RESERVED_EXCLUDED_STATES


def aggregate_reservations(rows):
    """rows: dicts with item_code, source_warehouse, required_qty.
    Returns {item_code: {warehouse: summed_qty}}. Blank item/warehouse skipped;
    missing qty treated as 0."""
    out = {}
    for r in rows:
        item = r.get("item_code")
        wh = r.get("source_warehouse")
        if not item or not wh:
            continue
        qty = float(r.get("required_qty") or 0)
        out.setdefault(item, {})
        out[item][wh] = out[item].get(wh, 0.0) + qty
    return out


import json

import frappe


@frappe.whitelist()
def get_store_reservations(warehouse, item_codes=None):
    """Reserved qty per item at one source warehouse, from AFP work orders that
    are drafted/submitted but not yet material-issued."""
    if isinstance(item_codes, str):
        item_codes = json.loads(item_codes) if item_codes.strip().startswith("[") else [item_codes]
    item_codes = [c for c in (item_codes or []) if c]
    if not warehouse or not item_codes:
        return {}

    rows = frappe.db.sql(
        """
        SELECT woi.item_code, woi.source_warehouse, woi.required_qty
        FROM `tabWork Order Item` woi
        JOIN `tabWork Order` wo ON wo.name = woi.parent
        WHERE wo.custom_type = 'Application Floor Plan'
          AND DATE(wo.creation) = %(today)s
          AND wo.docstatus < 2
          AND (wo.status IS NULL OR wo.status != 'Stopped')
          AND COALESCE(wo.workflow_state, 'Pending Submission') NOT IN
              ('Chemical Issued','Tank Mix Manufactured','Spraying In Progress','Completed')
          AND woi.source_warehouse = %(warehouse)s
          AND woi.item_code IN %(items)s
        """,
        {"warehouse": warehouse, "items": tuple(item_codes), "today": frappe.utils.today()},
        as_dict=True,
    )
    agg = aggregate_reservations(rows)
    return {item: agg.get(item, {}).get(warehouse, 0.0) for item in item_codes}
