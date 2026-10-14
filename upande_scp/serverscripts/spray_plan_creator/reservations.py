"""Draft-aware reservation math for Application Floor Plan work orders.

Pure helpers (no frappe imports) live at the top so they are unit-testable;
the whitelisted DB endpoint is added in a later task.
"""

# Once chemicals have left the source store the Bin already reflects it, so the
# plan must stop reserving (or the stock is counted twice).
RESERVED_EXCLUDED_STATES = {
    "Chemical Issued",
    "Chemicals Issued Direct",
    "Tank Mix Manufactured",
    "Spraying In Progress",
    "Completed",
}
DEAD_STATUSES = {"Stopped", "Closed", "Cancelled"}
DEFAULT_WINDOW_DAYS = 7


def is_reserved_state(workflow_state, status):
    """True when a work order still reserves source stock (drafted/submitted,
    not yet material-issued, not stopped)."""
    if status in DEAD_STATUSES:
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




def window_start(today, days):
    """ISO date string: plans planned before this no longer reserve."""
    from datetime import date, timedelta

    d = date.fromisoformat(str(today)[:10])
    return (d - timedelta(days=int(days))).isoformat()


def reserves(row, cutoff):
    """True when a plan row (workflow_state, status, docstatus,
    planned_start_date) still reserves stock: live, not issued, inside window."""
    if (row.get("docstatus") or 0) >= 2:
        return False
    if not is_reserved_state(row.get("workflow_state"), row.get("status")):
        return False
    planned = str(row.get("planned_start_date") or "")[:10]
    # An undated plan cannot be proven stale, so it keeps reserving.
    return not planned or planned >= cutoff


def is_stale(row, cutoff):
    """Live, not issued, but planned before the window: reserves nothing and
    is only clutter the store keeper should clear."""
    if (row.get("docstatus") or 0) >= 2:
        return False
    if not is_reserved_state(row.get("workflow_state"), row.get("status")):
        return False
    planned = str(row.get("planned_start_date") or "")[:10]
    return bool(planned) and planned < cutoff


def compute_available(ledger, reserved_others, this_qty=0.0):
    """Available after reservations of other plans and this plan's own qty.
    Unfloored: a negative number is the shortfall."""
    return float(ledger or 0) - float(reserved_others or 0) - float(this_qty or 0)


def check_rows(rows, ledger, reserved_by_item, reserved_by_batch, batch_ledger):
    """The gate. rows: [{item_code, source_warehouse, required_qty, batch_no}] of
    the plan being saved. ledger: {(item, wh): qty}; reserved_by_item:
    {(item, wh): qty of OTHER plans}; reserved_by_batch: {(item, wh, batch): qty};
    batch_ledger: {(item, wh, batch): qty}. Returns a list of shortfall dicts
    (empty = fine). Rows of the same item+warehouse are summed, so splitting a
    request over two rows cannot slip past."""
    need = {}
    need_b = {}
    for r in rows:
        item, wh = r.get("item_code"), r.get("source_warehouse")
        if not item or not wh:
            continue
        q = float(r.get("required_qty") or 0)
        need[(item, wh)] = need.get((item, wh), 0.0) + q
        b = r.get("batch_no")
        if b:
            need_b[(item, wh, b)] = need_b.get((item, wh, b), 0.0) + q
    out = []
    for (item, wh), q in need.items():
        if q <= 0:
            continue
        avail = compute_available(
            ledger.get((item, wh), 0), reserved_by_item.get((item, wh), 0)
        )
        if avail - q < -1e-6:
            out.append({"level": "item", "item_code": item, "warehouse": wh,
                        "available": avail, "requested": q})
    for (item, wh, b), q in need_b.items():
        if q <= 0:
            continue
        avail = compute_available(
            batch_ledger.get((item, wh, b), 0), reserved_by_batch.get((item, wh, b), 0)
        )
        if avail - q < -1e-6:
            out.append({"level": "batch", "item_code": item, "warehouse": wh,
                        "batch_no": b, "available": avail, "requested": q})
    return out


import json

import frappe

ALLOWED_ROLES = {"System Manager", "Administrator", "SCP General Manager", "SCP Chemical Store Keeper"}
AFP = "Application Floor Plan"


def get_window_days():
    try:
        return int(
            frappe.db.get_single_value(
                "Scouting and Crop Protection Settings", "reservation_window_days"
            )
            or DEFAULT_WINDOW_DAYS
        )
    except Exception:
        return DEFAULT_WINDOW_DAYS


def _cutoff():
    return window_start(frappe.utils.today(), get_window_days())


def _has_batch_col():
    return frappe.db.has_column("Work Order Item", "custom_batch_no")


def _reservation_rows(items, warehouse=None, exclude=None):
    """Raw rows from every AFP that is live and not issued, inside the window."""
    if not items:
        return []
    batch_sel = "woi.custom_batch_no" if _has_batch_col() else "NULL"
    rows = frappe.db.sql(
        f"""
        SELECT wo.name AS wo, wo.docstatus, wo.status, wo.workflow_state,
               wo.planned_start_date, woi.item_code, woi.source_warehouse,
               woi.required_qty, {batch_sel} AS batch_no
        FROM `tabWork Order Item` woi
        JOIN `tabWork Order` wo ON wo.name = woi.parent
        WHERE wo.custom_type = %(afp)s
          AND wo.docstatus < 2
          AND DATE(COALESCE(wo.planned_start_date, wo.creation)) >= %(cutoff)s
          AND (wo.status IS NULL OR wo.status NOT IN ('Stopped','Closed','Cancelled'))
          AND COALESCE(wo.workflow_state, 'Pending Submission') NOT IN %(issued)s
          AND woi.item_code IN %(items)s
          {"AND woi.source_warehouse = %(wh)s" if warehouse else ""}
          {"AND wo.name != %(exclude)s" if exclude else ""}
        """,
        {
            "afp": AFP,
            "cutoff": _cutoff(),
            "issued": tuple(RESERVED_EXCLUDED_STATES),
            "items": tuple(items),
            "wh": warehouse,
            "exclude": exclude,
        },
        as_dict=True,
    )
    return [r for r in rows if reserves(r, _cutoff())]


def _ledger(items, warehouse):
    rows = frappe.db.sql(
        "SELECT item_code, COALESCE(SUM(actual_qty),0) q FROM `tabBin` "
        "WHERE warehouse=%s AND item_code IN %s GROUP BY item_code",
        (warehouse, tuple(items)),
        as_dict=True,
    )
    return {r.item_code: float(r.q or 0) for r in rows}


@frappe.whitelist()
def get_store_reservations(warehouse, item_codes=None, exclude=None):
    """Reserved qty per item at one source warehouse (live, un-issued AFPs inside
    the reservation window; the plan named in ``exclude`` is left out)."""
    if isinstance(item_codes, str):
        item_codes = json.loads(item_codes) if item_codes.strip().startswith("[") else [item_codes]
    item_codes = [c for c in (item_codes or []) if c]
    if not warehouse or not item_codes:
        return {}
    agg = aggregate_reservations(_reservation_rows(item_codes, warehouse, exclude))
    return {item: agg.get(item, {}).get(warehouse, 0.0) for item in item_codes}


@frappe.whitelist()
def get_item_availability(warehouse, item_codes, exclude=None, requested=None):
    """Per item at a source store: ledger qty, reserved qty by other plans (with
    the reserving plan names), and per batch ledger/reserved/available.

    ``requested`` ({item: qty}, optional) adds this plan's two remaining figures:
    ``remaining_after_this_plan`` (other SUBMITTED plans only) and
    ``remaining_if_all_pending_approved`` (also counting every other draft).
    ``exclude`` is the plan being edited."""
    from upande_scp.serverscripts.store import batch_suggestion
    from upande_scp.serverscripts.store.batch_stock import available_in_store

    if isinstance(item_codes, str):
        item_codes = json.loads(item_codes)
    if isinstance(requested, str):
        requested = json.loads(requested)
    requested = requested or {}
    item_codes = [c for c in (item_codes or []) if c]
    if not warehouse or not item_codes:
        return {}

    ledger = _ledger(item_codes, warehouse)
    rows = _reservation_rows(item_codes, warehouse, exclude)
    batches = available_in_store([(i, warehouse) for i in item_codes])
    today = frappe.utils.today()
    tracked = {
        r["name"]: int(r["has_batch_no"] or 0)
        for r in frappe.get_all("Item", filters={"name": ("in", item_codes)},
                                fields=["name", "has_batch_no"])
    }

    out = {}
    for item in item_codes:
        mine = [r for r in rows if r["item_code"] == item]
        firm = sum(float(r["required_qty"] or 0) for r in mine if r["docstatus"] == 1)
        total = sum(float(r["required_qty"] or 0) for r in mine)
        by_plan = {}
        by_batch = {}
        for r in mine:
            by_plan[r["wo"]] = by_plan.get(r["wo"], 0.0) + float(r["required_qty"] or 0)
            if r.get("batch_no"):
                by_batch[r["batch_no"]] = by_batch.get(r["batch_no"], 0.0) + float(r["required_qty"] or 0)
        lq = ledger.get(item, 0.0)
        pool = batches.get((item, warehouse), [])
        ranked = {b["batch_no"]: i for i, b in enumerate(batch_suggestion.rank_batches(pool, today))}
        blist = []
        for b in pool:
            res = by_batch.get(b["batch_no"], 0.0)
            ph = batch_suggestion.is_placeholder(b["batch_no"])
            blist.append({
                "batch_no": b["batch_no"],
                "qty": b["qty"],
                "expiry_date": str(b["expiry_date"]) if b.get("expiry_date") else None,
                "reserved": res,
                "available": b["qty"] - res,
                "placeholder": ph,
                "expired": b["batch_no"] not in ranked,
                "rank": ranked.get(b["batch_no"], 10_000),
            })
        blist.sort(key=lambda x: (x["rank"], x["batch_no"]))
        entry = {
            "ledger": lq,
            "reserved": total,
            "reserved_submitted": firm,
            "reserved_by": [{"name": n, "qty": q} for n, q in
                            sorted(by_plan.items(), key=lambda kv: -kv[1])],
            "has_batch_no": tracked.get(item, 0),
            "batches": blist,
        }
        if item in requested:
            q = float(requested[item] or 0)
            entry["remaining_after_this_plan"] = compute_available(lq, firm, q)
            entry["remaining_if_all_pending_approved"] = compute_available(lq, total, q)
        out[item] = entry
    return out


def enforce_stock_gate(doc, method=None):
    """Work Order validate hook: the real, frontend-independent gate. Refuses an
    AFP whose required items exceed ledger minus other plans' reservations."""
    if doc.get("custom_type") != AFP or doc.docstatus >= 2:
        return
    if frappe.flags.in_patch or frappe.flags.in_migrate or frappe.flags.in_install \
            or frappe.flags.get("skip_stock_gate"):
        return
    if (doc.get("workflow_state") in RESERVED_EXCLUDED_STATES
            or doc.get("status") in DEAD_STATUSES):
        return

    from upande_scp.serverscripts.store.batch_stock import available_in_store

    lines = [
        {"item_code": r.item_code, "source_warehouse": r.source_warehouse,
         "required_qty": r.required_qty, "batch_no": r.get("custom_batch_no")}
        for r in (doc.get("required_items") or [])
        if r.item_code and r.source_warehouse
    ]
    if not lines:
        return
    # Only stock items can run short.
    stock_items = {
        r.name for r in frappe.get_all(
            "Item", filters={"name": ("in", list({l["item_code"] for l in lines})),
                             "is_stock_item": 1}, fields=["name"])
    }
    lines = [l for l in lines if l["item_code"] in stock_items]
    if not lines:
        return

    ledger, reserved, reserved_b, batch_ledger = {}, {}, {}, {}
    who = {}
    for wh in {l["source_warehouse"] for l in lines}:
        items = sorted({l["item_code"] for l in lines if l["source_warehouse"] == wh})
        for i, q in _ledger(items, wh).items():
            ledger[(i, wh)] = q
        for r in _reservation_rows(items, wh, exclude=doc.name if not doc.is_new() else None):
            k = (r["item_code"], wh)
            reserved[k] = reserved.get(k, 0.0) + float(r["required_qty"] or 0)
            who.setdefault(k, {})
            who[k][r["wo"]] = who[k].get(r["wo"], 0.0) + float(r["required_qty"] or 0)
            if r.get("batch_no"):
                kb = (r["item_code"], wh, r["batch_no"])
                reserved_b[kb] = reserved_b.get(kb, 0.0) + float(r["required_qty"] or 0)
    if any(l["batch_no"] for l in lines):
        pools = available_in_store([(l["item_code"], l["source_warehouse"]) for l in lines if l["batch_no"]])
        for (i, wh), pool in pools.items():
            for b in pool:
                batch_ledger[(i, wh, b["batch_no"])] = b["qty"]

    short = check_rows(lines, ledger, reserved, reserved_b, batch_ledger)
    if not short:
        return
    msgs = []
    for s in short:
        top = sorted((who.get((s["item_code"], s["warehouse"]), {})).items(), key=lambda kv: -kv[1])[:3]
        holders = ", ".join(f"{n} ({q:g})" for n, q in top) or "none"
        what = f"{s['item_code']} batch {s['batch_no']}" if s["level"] == "batch" else s["item_code"]
        msgs.append(
            f"{what} at {s['warehouse']}: available {max(s['available'], 0):g}, "
            f"requested {s['requested']:g}. Reserved by other plans: {holders}."
        )
    frappe.throw(
        "Not enough stock for this plan after other plans' reservations:<br>"
        + "<br>".join(msgs),
        title="Insufficient chemical stock",
    )


def _check_roles():
    if not (set(frappe.get_roles()) & ALLOWED_ROLES):
        frappe.throw("Not permitted to manage stale spray plans.", frappe.PermissionError)


def _stale_filters_sql(farm):
    return (
        "LEFT JOIN `tabWarehouse` gh ON gh.name = wo.custom_greenhouse"
        if farm else ""
    )


@frappe.whitelist()
def get_stale_plans(farm=None):
    """AFPs planned before the reservation window that are still live and not
    issued: they no longer reserve stock but still clutter the approval queue."""
    _check_roles()
    rows = frappe.db.sql(
        f"""
        SELECT wo.name, wo.docstatus, wo.status, wo.workflow_state,
               wo.planned_start_date, wo.creation, wo.owner, wo.custom_greenhouse,
               wo.production_item
        FROM `tabWork Order` wo
        {_stale_filters_sql(farm)}
        WHERE wo.custom_type = %(afp)s
          AND wo.docstatus < 2
          AND wo.planned_start_date IS NOT NULL
          AND DATE(wo.planned_start_date) < %(cutoff)s
          AND (wo.status IS NULL OR wo.status NOT IN ('Stopped','Closed','Cancelled'))
          AND COALESCE(wo.workflow_state, 'Pending Submission') NOT IN %(issued)s
          {"AND gh.custom_farm = %(farm)s" if farm else ""}
        ORDER BY wo.planned_start_date
        LIMIT 1000
        """,
        {"afp": AFP, "cutoff": _cutoff(), "issued": tuple(RESERVED_EXCLUDED_STATES), "farm": farm},
        as_dict=True,
    )
    return [dict(r, planned_start_date=str(r.planned_start_date), creation=str(r.creation))
            for r in rows if is_stale(r, _cutoff())]


@frappe.whitelist()
def stop_stale_plans(names):
    """Stop the chosen stale plans: submitted -> ERPNext Stopped (as the dormant
    sweep does), drafts -> deleted. Re-checks staleness per plan, so a plan that
    became current or was issued meanwhile is skipped, never stopped."""
    _check_roles()
    if isinstance(names, str):
        names = json.loads(names)
    from upande_scp.serverscripts.spray_plan_creator.maintenance import _stop_submitted

    cutoff = _cutoff()
    stopped, deleted, skipped, failed = [], [], [], []
    for n in names or []:
        try:
            wo = frappe.get_doc("Work Order", n)
            if wo.get("custom_type") != AFP or not is_stale(
                {"docstatus": wo.docstatus, "status": wo.status,
                 "workflow_state": wo.get("workflow_state"),
                 "planned_start_date": wo.planned_start_date}, cutoff):
                skipped.append(n)
                continue
            if wo.docstatus == 1:
                _stop_submitted(wo)
                stopped.append(n)
            else:
                frappe.delete_doc("Work Order", n, ignore_permissions=True)
                deleted.append(n)
            frappe.db.commit()
        except Exception:
            frappe.db.rollback()
            failed.append(n)
            frappe.log_error(frappe.get_traceback(), f"stop_stale_plans: {n}")
    return {"stopped": stopped, "deleted": deleted, "skipped": skipped, "failed": failed}
