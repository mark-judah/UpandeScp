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
