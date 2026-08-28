"""
Server-side API for the Spray Plan Approval page.

Whitelisted endpoints:
  get_pending_work_orders(from_date, to_date, farm, greenhouse)
  get_farms_and_greenhouses()
  approve_single_work_order(wo_name)
  stop_single_work_order(wo_name)
"""

import re

import frappe
from frappe.utils import add_days, cstr, flt, now_datetime, today

from upande_scp.serverscripts.common import crop_scope
from upande_scp.serverscripts.store.spray_stock_types import SE_TYPE_TRANSFER

AFP_TYPE = "Application Floor Plan"

APPROVAL_ROLES = ("SCP Spray Plan Approver", "SCP General Manager")


def _ensure_approval_role():
    """Mirror the page-level role gate from
    ``upande_scp/www/spray_plan_approval/index.py`` so that direct API
    calls (e.g. from the React app or REST clients) cannot bypass it."""
    user = frappe.session.user
    if not user or user == "Guest":
        frappe.throw("Please log in to use spray plan approval.", frappe.PermissionError)
    user_roles = set(frappe.get_roles(user))
    if not user_roles.intersection(APPROVAL_ROLES):
        frappe.throw(
            "Spray plan approval requires the SCP General Manager or SCP Spray Plan Approver role.",
            frappe.PermissionError,
        )


def _ensure_wo_in_approver_scope(wo_name: str) -> None:
    """Reject approve/stop calls on a Work Order outside the caller's farms.

    Two scopes, both enforced. The approver roster passes ``None`` for a general
    manager, so on its own it let a GM at Kaitet Ltd. approve a Karen Roses plan by
    name — listing and acting are different doors, and closing only the one the UI uses
    is not closing it.
    """
    gh = frappe.db.get_value("Work Order", wo_name, "custom_greenhouse")
    scoped = crop_scope.scoped_greenhouses(None, frappe.session.user)
    if scoped is not None and gh and gh not in scoped:
        frappe.throw(
            f"{gh} is not on a farm your company grows on.",
            frappe.PermissionError,
        )

    allowed = _approver_allowed_greenhouses(frappe.session.user)
    if allowed is None:
        return
    if not allowed:
        frappe.throw(
            "You are not assigned to any farm. Ask the SCP General Manager to "
            "roster you on the Settings → Access tab.",
            frappe.PermissionError,
        )
    gh = frappe.db.get_value("Work Order", wo_name, "custom_greenhouse")
    if gh and gh not in allowed:
        frappe.throw(
            f"You are not authorised to approve work orders for {gh}.",
            frappe.PermissionError,
        )


def _approver_allowed_greenhouses(user: str) -> list[str] | None:
    """Return the list of greenhouse warehouse names this user can act on,
    or ``None`` for unscoped access (General Manager / Administrator).

    Spray Plan Approvers are limited to the farms the GM has rostered them
    on via the Settings → Access tab. An approver with no farms returns
    ``[]`` and the calling endpoint short-circuits to an empty result.
    """
    if user == "Administrator":
        return None
    roles = set(frappe.get_roles(user))
    if "SCP General Manager" in roles or "System Manager" in roles:
        return None
    if "SCP Spray Plan Approver" not in roles:
        # Defence in depth — _ensure_approval_role already rejected this.
        return []
    if not frappe.db.table_exists("Farm Spray Plan Approver"):
        return []
    farms = [
        row.parent for row in frappe.get_all(
            "Farm Spray Plan Approver",
            filters={"user": user, "parenttype": "Farm"},
            fields=["parent"],
        )
    ]
    if not farms:
        return []
    greenhouses = frappe.get_all(
        "Warehouse",
        filters={
            "custom_farm": ["in", farms],
            "warehouse_type": "Greenhouse",
            "disabled": 0,
        },
        fields=["name"],
    )
    return [g["name"] for g in greenhouses]


# ── Public API ────────────────────────────────────────────────────────────────


@frappe.whitelist()
def get_pending_work_orders(from_date=None, to_date=None, farm=None, greenhouse=None):
    _ensure_approval_role()
    """
    Return AFP Work Orders (Not Started, submitted) with child items
    and forwarding status (draft SE exists?).
    Date range applies to COALESCE(custom_scheduled_application_time, planned_start_date)
    so WOs without an explicit scheduled time still match against their planning time.
    """
    params = {"type": AFP_TYPE}
    where = [
        "custom_type = %(type)s",
        "workflow_state = 'Awaiting Approval'",
        "docstatus = 1",
    ]

    if from_date:
        where.append(
            "COALESCE(custom_scheduled_application_time, planned_start_date) >= %(from_date)s"
        )
        params["from_date"] = from_date + " 00:00:00"
    if to_date:
        where.append(
            "COALESCE(custom_scheduled_application_time, planned_start_date) < %(to_date)s"
        )
        params["to_date"] = str(add_days(to_date, 1)) + " 00:00:00"

    if greenhouse:
        where.append("custom_greenhouse = %(greenhouse)s")
        params["greenhouse"] = greenhouse
    elif farm:
        where.append("custom_greenhouse LIKE %(farm_prefix)s")
        params["farm_prefix"] = farm + " GH%"

    # Farm scoping, from two independent sources that both have to hold.
    #
    # The approver roster answers "which farms are you rostered on" and passes ``None``
    # for a GM. The crop gate answers "which farms does your company grow on" and passes
    # ``None`` only for an administrator. Before the crop gate this query ran on raw SQL
    # with only the roster applied, so a general manager at Kaitet Ltd. was served all
    # 707 pending Karen Roses plans — `permission_query_conditions` cannot reach
    # `frappe.db.sql`, which is exactly why this is applied by hand here.
    limits = []
    roster = _approver_allowed_greenhouses(frappe.session.user)
    if roster is not None:
        limits.append(set(roster))
    scoped = crop_scope.scoped_greenhouses(None, frappe.session.user)
    if scoped is not None:
        limits.append(scoped)

    if limits:
        allowed_ghs = set.intersection(*limits)
        if not allowed_ghs:
            return {"work_orders": [], "farms": []}
        where.append("custom_greenhouse IN %(allowed_ghs)s")
        params["allowed_ghs"] = tuple(sorted(allowed_ghs))

    wos = frappe.db.sql(
        """
        SELECT
            name, custom_greenhouse, creation,
            custom_scheduled_application_time,
            custom_spray_type, custom_scope, custom_scope_details,
            custom_area, custom_water_volume, custom_water_ph,
            custom_water_hardness, custom_kit, wip_warehouse,
            custom_targets
        FROM `tabWork Order`
        WHERE {where}
        ORDER BY COALESCE(custom_scheduled_application_time, planned_start_date) DESC,
                 creation DESC
        """.format(where=" AND ".join(where)),
        params,
        as_dict=1,
    )

    if not wos:
        return {"work_orders": [], "farms": []}

    wo_names = [w.name for w in wos]

    # ── Child items ──
    item_rows = frappe.get_all(
        "Work Order Item",
        filters={"parent": ["in", wo_names]},
        fields=["parent", "item_code", "item_name", "required_qty", "stock_uom"],
        order_by="idx asc",
        limit=0,
    )
    items_by_wo = {}
    for r in item_rows:
        items_by_wo.setdefault(r.parent, []).append(r)

    # ── Already forwarded? (draft Material Transfer SE exists) ──
    se_rows = frappe.get_all(
        "Stock Entry",
        filters=[
            ["work_order", "in", wo_names],
            ["purpose",    "=", "Material Transfer for Manufacture"],
            ["docstatus",  "=", 0],
        ],
        fields=["work_order"],
        limit=0,
    )
    forwarded = {r.work_order for r in se_rows}

    farms = set()
    result = []
    for wo in wos:
        farm_name = _derive_farm(wo.custom_greenhouse)
        if farm_name:
            farms.add(farm_name)
        result.append(
            {
                **wo,
                "required_items": items_by_wo.get(wo.name, []),
                "is_forwarded":   wo.name in forwarded,
                "farm":           farm_name,
            }
        )

    return {"work_orders": result, "farms": sorted(farms)}


@frappe.whitelist()
def get_farms_and_greenhouses(crop=None):
    """Return distinct farms and their greenhouse lists (from open WOs).

    Two narrowings apply, and they are different things. The approver roster and the
    crop gate both answer *who you are*: an approver sees the farms they are rostered
    on, and nobody sees a farm outside their company's crops. `crop` answers *where you
    are* — inside the Avocado section a farm picker should offer Lokitela alone, even
    to an administrator entitled to every farm. Context narrows everyone; permission
    narrows further. The answer is the intersection of whichever apply.
    """
    _ensure_approval_role()
    wo_filters: list = [
        ["custom_type", "=", AFP_TYPE],
        ["status",      "=", "Not Started"],
        ["docstatus",   "=", 1],
    ]

    limits = []
    roster = _approver_allowed_greenhouses(frappe.session.user)
    if roster is not None:
        limits.append(set(roster))
    scoped = crop_scope.scoped_greenhouses(crop, frappe.session.user)
    if scoped is not None:
        limits.append(scoped)

    if limits:
        allowed_ghs = set.intersection(*limits)
        if not allowed_ghs:
            return {"farms": [], "greenhouses_by_farm": {}}
        wo_filters.append(["custom_greenhouse", "in", sorted(allowed_ghs)])

    wos = frappe.get_all(
        "Work Order",
        filters=wo_filters,
        fields=["custom_greenhouse"],
        group_by="custom_greenhouse",
        limit=0,
    )

    farms_map = {}
    for wo in wos:
        gh = wo.custom_greenhouse
        if not gh:
            continue
        farm = _derive_farm(gh)
        if farm:
            farms_map.setdefault(farm, []).append(gh)

    return {
        "farms": sorted(farms_map.keys()),
        "greenhouses_by_farm": {f: sorted(ghs) for f, ghs in farms_map.items()},
    }


@frappe.whitelist()
def approve_single_work_order(wo_name):
    """
    Create a draft Material Transfer for Manufacture SE for one Work Order.
    Fixes zero valuation rates via FIFO.
    Does NOT generate labels: the traceable codes are issued when the storesman
    submits the transfer, because only then is the quantity what actually moved.
    `qr_labels` is returned empty and kept for shape compatibility with the client.

    Returns a dict with keys: wo, status, se, warehouse, qr_labels, message.
    """
    _ensure_approval_role()
    _ensure_wo_in_approver_scope(wo_name)

    # Row-lock the WO so the duplicate-SE guard below is atomic with the
    # subsequent insert. Without this, two concurrent approve calls can
    # both pass the guard and each create a draft SE — the second one
    # then fails to submit with "Material Transferred for Manufacturing
    # cannot be greater than planned quantity".
    locked = frappe.db.sql(
        "SELECT name FROM `tabWork Order` WHERE name=%s FOR UPDATE",
        wo_name,
    )
    if not locked:
        return {"wo": wo_name, "status": "error", "message": "Work order not found."}

    try:
        wo_doc = frappe.get_doc("Work Order", wo_name)
    except frappe.DoesNotExistError:
        return {"wo": wo_name, "status": "error", "message": "Work order not found."}

    # The canonical readiness signal for Application Floor Plan WOs is our
    # own workflow_state, not ERPNext's manufacturing `status` field. The
    # bulk-submit endpoint sets docstatus=1 via raw SQL without going through
    # ERPNext's save path, so `status` stays at 'Draft' even though the WO
    # is fully submitted and awaiting approval.
    if wo_doc.workflow_state != "Awaiting Approval":
        return {
            "wo":      wo_name,
            "status":  "skipped",
            "message": f"Skipped — workflow state is '{wo_doc.workflow_state or 'unset'}'.",
        }

    # Guard: any non-cancelled MTM SE already exists?
    existing = frappe.get_all(
        "Stock Entry",
        filters=[
            ["work_order", "=", wo_name],
            ["purpose",    "=", "Material Transfer for Manufacture"],
            ["docstatus",  "<", 2],
        ],
        fields=["name"],
        limit=1,
    )
    if existing:
        return {
            "wo":      wo_name,
            "status":  "already_forwarded",
            "se":      existing[0].name,
            "message": f"Already forwarded as {existing[0].name}.",
        }

    try:
        from erpnext.manufacturing.doctype.work_order.work_order import (
            make_stock_entry as _make_se,
        )
        se_data = _make_se(work_order_id=wo_name, purpose="Material Transfer for Manufacture")
        if not se_data:
            return {"wo": wo_name, "status": "error", "message": "Could not generate stock entry data."}

        se_doc = frappe.get_doc(se_data) if isinstance(se_data, dict) else se_data
        se_doc.stock_entry_type = SE_TYPE_TRANSFER
        se_doc.insert(ignore_permissions=True)
        frappe.db.commit()
    except Exception:
        frappe.log_error(frappe.get_traceback(), f"Spray Approval – create SE: {wo_name}")
        return {"wo": wo_name, "status": "error", "message": _friendly_error(frappe.get_traceback())}

    # ── Fix zero valuation rates ──
    try:
        changed = _patch_zero_rates(se_doc)
        if changed:
            se_doc.save(ignore_permissions=True)
            frappe.db.commit()
    except Exception:
        frappe.log_error(frappe.get_traceback(), f"Rate patch – {se_doc.name}")

    # ── No QR labels here, deliberately ──
    # Codes are issued when the storesman SUBMITS this transfer (see
    # stock_entry_state.on_submit → chemical_labels.issue_for_stock_entry), not now.
    # At this point the Stock Entry is a draft: nothing has moved, and the quantity on
    # each line is a proposal the storesman can still change. A label printed from it
    # carried a number that was never checked against what was issued.
    #
    # Nothing downstream regresses: store_label_printing already only printed labels
    # for submitted entries (docstatus=1 AND has_qr), so this removes QR images that
    # existed for drafts which may never be submitted at all.
    qr_labels: list = []

    # Bump workflow state to Approved (Task 16 of Spray Plan A1)
    frappe.db.set_value("Work Order", wo_name, "workflow_state", "Approved", update_modified=True)
    try:
        frappe.get_doc("Work Order", wo_name).add_comment(
            "Workflow",
            f"Approved by {frappe.session.user}. State: Awaiting Approval -> Approved.",
        )
    except Exception:
        # Comment add failure must not block approval
        pass

    return {
        "wo":        wo_name,
        "se":        se_doc.name,
        "warehouse": wo_doc.wip_warehouse or "",
        "status":    "approved",
        "qr_labels": qr_labels,
    }


@frappe.whitelist()
def stop_single_work_order(wo_name):
    """Stop (cancel) a single Work Order. Returns {wo, status, message}."""
    _ensure_approval_role()
    _ensure_wo_in_approver_scope(wo_name)
    try:
        from erpnext.manufacturing.doctype.work_order.work_order import stop_unstop
        stop_unstop(wo_name, "Stopped")
        return {"wo": wo_name, "status": "stopped"}
    except Exception:
        frappe.log_error(frappe.get_traceback(), f"Spray Stop – {wo_name}")
        return {
            "wo":      wo_name,
            "status":  "error",
            "message": _friendly_error(frappe.get_traceback()),
        }


# ── Internal helpers ──────────────────────────────────────────────────────────


def _derive_farm(greenhouse):
    if not greenhouse:
        return None
    m = re.match(r"^(.+?)\s+GH\b", str(greenhouse), re.IGNORECASE)
    return m.group(1).strip() if m else str(greenhouse).split(" ")[0]


def _friendly_error(raw):
    """Map raw exception text to a user-readable sentence.

    Rule order matters: more-specific exception names come before generic
    substrings. The 'permission' pattern is matched against the exception
    class name only (not the traceback body) so that 'ignore_permissions=True'
    appearing in a stack frame doesn't masquerade as a real PermissionError.
    """
    text = cstr(raw)
    lower = text.lower()

    # Match exception class names where they appear after a colon so we
    # ignore code text like `ignore_permissions=True` in tracebacks.
    if "mandatoryerror" in lower:
        return "Required fields are missing. Check the work order setup."
    if "permissionerror" in lower:
        return "You do not have permission to perform this action."

    rules = [
        ("not enough stock",        "Insufficient stock in the source warehouse. Check inventory."),
        ("negative stock",          "This transfer would create negative stock. Verify warehouse balances."),
        ("does not exist",          "The work order or a referenced document could not be found."),
        ("already a stock entry",   "A stock transfer already exists for this work order."),
        ("docstatus",               "The work order is not in a valid state for processing."),
        ("mandatory",               "Required fields are missing. Check the work order setup."),
        ("valuation",               "Item valuation rate is missing. Run a stock reconciliation first."),
        ("bom",                     "No Bill of Materials found for this work order."),
        ("qty",                     "Quantity mismatch. Verify the work order quantities."),
    ]
    for pattern, friendly in rules:
        if pattern in lower:
            return friendly
    return "Could not process this work order. Your administrator has been notified."


def _patch_zero_rates(se_doc):
    """
    Fill any zero basic_rate on SE items from FIFO ledger.
    Returns True if any rate was updated.
    """
    try:
        from erpnext.stock.utils import get_incoming_rate
    except ImportError:
        return False

    post_date = today()
    post_time = now_datetime().strftime("%H:%M:%S")
    changed = False

    for item in se_doc.items or []:
        if flt(item.basic_rate) or not item.s_warehouse:
            continue
        try:
            rate = get_incoming_rate(
                {
                    "item_code":    item.item_code,
                    "warehouse":    item.s_warehouse,
                    "posting_date": post_date,
                    "posting_time": post_time,
                    "qty":          item.qty,
                    "voucher_type": "Stock Entry",
                    "company":      se_doc.company,
                }
            )
            if flt(rate) > 0:
                item.basic_rate     = rate
                item.valuation_rate = rate
                item.amount         = flt(rate) * flt(item.qty)
                changed = True
        except Exception:
            frappe.log_error(frappe.get_traceback(), f"FIFO rate – {item.item_code}")

    return changed
