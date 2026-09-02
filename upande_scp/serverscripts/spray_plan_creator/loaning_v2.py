"""Directed, multi-item chemical loaning.

A borrowing farm's planner addresses ONE lending farm and asks for one or more
chemicals. The lender decides each line on its own — approve in full, approve
less, or reject — because "I can spare the Amisil but not the Tepeki" is the
normal answer, not an edge case.

Three things this changes from the original flow:

* **Directed, not split.** The old model let a requester spread one chemical over
  up to five lenders, which meant every farm could see the request. One lender
  per request is what makes it private to them.
* **Private for real.** Visibility is enforced by a permission query condition
  (see ``permission_query_conditions`` in hooks), not by filtering in the UI —
  the latter would leave the rows readable over the REST API.
* **Stock is disclosed narrowly.** A requester never browses the lender's
  inventory; they name the items they want and get on-hand for those only.
* **Chemicals AND foliars.** Both are loanable, and each moves between stores of
  its own kind — a foliar travels fertilizer-store to fertilizer-store, never
  into a chemical store. Which item groups count as which is configuration
  (``crop_protection.product_groups``), not a name pattern.

On approval a single Material Transfer Stock Entry carries every approved line
from the lender's chemical store to the borrower's — one document rather than one
per chemical, so the movement reads as the single event it is.
"""
from __future__ import annotations

import json

import frappe

from upande_scp.serverscripts.common import crop_scope
from upande_scp.serverscripts.common import stores
from frappe.utils import flt, now_datetime

from upande_scp.serverscripts.common.crop_protection import is_foliar_group
from upande_scp.serverscripts.common.notifications import notify, users_for_farm
from upande_scp.serverscripts.spray_plan_creator.loaning import (
    ELEVATED,
    _assert_farm_access,
    _ensure_creator,
    _ensure_enabled,
    _farm_chemical_stores,
    _primary_store,
    _user_farms,
)
from upande_scp.serverscripts.spray_plan_creator.validation import match_cost_center
from upande_scp.serverscripts.store.spray_stock_types import SE_TYPE_LOAN

DOCTYPE = "Chemical Transfer Request"

#: A request taking more than this share of the lender's on-hand earns them a
#: heads-up. Informational only — it never blocks. Note two requests at 40% each
#: trigger nothing individually but together take 80%; accepted, because this is
#: a courtesy and not a control.
HALF_STOCK_WARN = 0.5


def farm_company(farm: str) -> str | None:
    """The company a farm's stores belong to."""
    if not farm:
        return None
    for kind in ("chemical", "foliar"):
        for wh in _stores_of_kind(farm, kind):
            company = frappe.db.get_value("Warehouse", wh, "company")
            if company:
                return company
    return None


def item_kind(item_code: str) -> str:
    """``"foliar"`` or ``"chemical"`` for an item, from the configured groups."""
    group = frappe.db.get_value("Item", item_code, "item_group")
    return "foliar" if is_foliar_group(group) else "chemical"


def _stores_of_kind(farm: str, kind: str) -> list[str]:
    """A farm's stores for this kind of product.

    Prefers the farm's explicit mapping (``custom_chemical_store`` /
    ``custom_fertilizer_store``), which is the same edge the Application Plan's
    store lock uses, and falls back to a name match for farms that were never
    mapped.
    """
    return stores.farm_stores(farm, "foliar" if kind == "foliar" else "chemical")


def store_for(farm: str, item_code: str) -> str | None:
    """The one store at `farm` that this item belongs in."""
    stores = _stores_of_kind(farm, item_kind(item_code))
    return stores[0] if stores else None


def item_on_hand(farm: str, item_code: str) -> float:
    """On-hand at `farm` across the stores of that item's own kind.

    Not the chemical-store-only lookup the original flow used — a foliar lives in
    the fertilizer store, and counting it as zero would make every foliar look
    unborrowable.
    """
    stores = _stores_of_kind(farm, item_kind(item_code))
    if not stores:
        return 0.0
    row = frappe.db.sql(
        """SELECT COALESCE(SUM(actual_qty), 0) q FROM `tabBin`
           WHERE item_code = %s AND warehouse IN %s""",
        (item_code, tuple(stores)),
        as_dict=True,
    )
    return flt(row[0]["q"]) if row else 0.0


def _as_list(payload):
    if isinstance(payload, str):
        payload = json.loads(payload)
    return payload or {}


# ───────────────────────────────── reads ─────────────────────────────────────


@frappe.whitelist()
def list_lender_farms(requesting_farm: str) -> list[str]:
    """Farms that could lend to `requesting_farm`.

    Any farm with a chemical OR a fertilizer store, since both chemicals and
    foliars are loanable. Names only; no stock is disclosed here.
    """
    _ensure_enabled()
    _ensure_creator()
    _assert_farm_access(requesting_farm)

    # A farm can lend only what it has a store for. `Farm.custom_chemical_store`
    # / `custom_fertilizer_store` are that mapping — the `LIKE 'Chemical Store%'`
    # sweep this replaces enumerated every farm on the site by warehouse-name
    # convention, which is both a naming assumption and, on any site with more
    # than one company, a disclosure: the borrower saw farms they have no
    # business borrowing from.
    lenders = set(stores.farms_with_stores())

    # Then narrow to what this borrower may see at all. Loaning is a
    # farm-to-farm transfer inside one company; crossing a company boundary is
    # not a loan, it is a sale.
    visible = crop_scope.visible_farms(user=frappe.session.user)
    if visible is not None:
        lenders &= visible

    lenders.discard(requesting_farm)
    return sorted(lenders)


@frappe.whitelist()
def get_lender_stock(lender_farm: str, item_codes) -> dict:
    """On-hand at `lender_farm` for the named items only.

    Deliberately NOT a browse endpoint: a borrower has no business enumerating
    another farm's inventory, so they must name what they want first. Returns
    ``{item_code: {on_hand, uom, over_half}}``.
    """
    _ensure_enabled()
    _ensure_creator()
    if isinstance(item_codes, str):
        try:
            item_codes = json.loads(item_codes)
        except (TypeError, ValueError):
            item_codes = [c.strip() for c in item_codes.split(",") if c.strip()]
    item_codes = [c for c in (item_codes or []) if c]
    if not lender_farm or not item_codes:
        return {}

    out = {}
    for code in item_codes:
        on_hand = item_on_hand(lender_farm, code)
        out[code] = {
            "on_hand": on_hand,
            "uom": frappe.db.get_value("Item", code, "stock_uom") or "",
            # So the UI can group chemicals and foliars, and show which store
            # the stock will actually come from.
            "kind": item_kind(code),
            "store": store_for(lender_farm, code),
        }
    return out


@frappe.whitelist()
def list_requests_v2(box: str = "outgoing") -> list[dict]:
    """``outgoing`` = requests this user's farms raised.
    ``incoming`` = requests addressed TO this user's farms, for them to decide.

    Both are farm-scoped for a plain planner; elevated roles see everything.
    """
    _ensure_creator()
    allowed = _user_farms()
    filters: dict = {}
    if allowed is not None:
        farms = list(allowed) or ["__none__"]
        filters["requesting_farm" if box == "outgoing" else "lender_farm"] = ("in", farms)

    rows = frappe.get_all(
        DOCTYPE,
        filters=filters,
        fields=[
            "name", "requesting_farm", "requesting_warehouse", "lender_farm",
            "lender_warehouse", "workflow_state", "reason", "expires_on",
            "rejected_reason", "creation", "owner",
        ],
        order_by="creation desc",
        limit_page_length=200,
    )
    names = [r.name for r in rows]
    items_by_parent: dict = {}
    if names:
        for it in frappe.get_all(
            "Chemical Transfer Request Item",
            filters={"parent": ("in", names), "parenttype": DOCTYPE},
            fields=[
                "parent", "item_code", "item_name", "uom", "requested_qty",
                "status", "approved_qty", "lender_on_hand", "stock_entry", "idx",
            ],
            order_by="parent asc, idx asc",
        ):
            items_by_parent.setdefault(it.parent, []).append(it)
    for r in rows:
        r["items"] = items_by_parent.get(r.name, [])
    return rows


# ──────────────────────────────── writes ─────────────────────────────────────


@frappe.whitelist()
def create_loan_request(payload) -> dict:
    """Raise one request from a farm to a single lender, for one or more items.

    Returns ``{name, over_half: [item_code, ...]}`` so the borrower sees the same
    courtesy warning the lender is sent.
    """
    _ensure_enabled()
    _ensure_creator()
    data = _as_list(payload)

    requesting_farm = (data.get("requesting_farm") or "").strip()
    lender_farm = (data.get("lender_farm") or "").strip()
    items = data.get("items") or []
    reason = (data.get("reason") or "").strip()

    if not requesting_farm or not lender_farm:
        frappe.throw("Both the requesting farm and the lender farm are required.")
    if requesting_farm == lender_farm:
        frappe.throw("A farm cannot borrow from itself.")

    # Stock cannot cross companies in a single Material Transfer — that is an
    # inter-company transaction with its own documents and accounting. Refuse it
    # here, plainly, rather than letting ERPNext raise
    # InvalidWarehouseCompany at approval time when the lender has already
    # agreed and the borrower is waiting.
    borrower_co = farm_company(requesting_farm)
    lender_co = farm_company(lender_farm)
    if borrower_co and lender_co and borrower_co != lender_co:
        frappe.throw(
            f"{requesting_farm} ({borrower_co}) and {lender_farm} ({lender_co}) "
            f"are different companies. A loan moves stock in one transfer, which "
            f"cannot cross companies — this needs an inter-company transfer instead."
        )
    if not items:
        frappe.throw("Add at least one chemical to borrow.")
    _assert_farm_access(requesting_farm)

    requesting_store = _primary_store(requesting_farm)
    lender_store = _primary_store(lender_farm)
    if not requesting_store:
        frappe.throw(f"{requesting_farm} has no chemical store to receive into.")
    if not lender_store:
        frappe.throw(f"{lender_farm} has no chemical store to lend from.")

    doc = frappe.new_doc(DOCTYPE)
    doc.requesting_farm = requesting_farm
    doc.requesting_warehouse = requesting_store
    doc.lender_farm = lender_farm
    doc.lender_warehouse = lender_store
    doc.workflow_state = "Pending Approval"
    doc.reason = reason
    if data.get("expires_on"):
        doc.expires_on = data["expires_on"]

    over_half = []
    seen = set()
    for raw in items:
        code = (raw.get("item_code") or "").strip()
        qty = flt(raw.get("requested_qty"))
        if not code or qty <= 0:
            frappe.throw("Every line needs a chemical and a positive quantity.")
        if code in seen:
            frappe.throw(f"{code} is listed twice — combine it into one line.")
        seen.add(code)

        on_hand = item_on_hand(lender_farm, code)
        if qty > on_hand:
            frappe.throw(
                f"{lender_farm} only has {on_hand:g} of {code}; asked for {qty:g}."
            )
        if on_hand > 0 and qty > on_hand * HALF_STOCK_WARN:
            over_half.append(code)

        doc.append("items", {
            "item_code": code,
            "item_name": frappe.db.get_value("Item", code, "item_name") or code,
            "uom": frappe.db.get_value("Item", code, "stock_uom") or "",
            "requested_qty": qty,
            "status": "Pending",
            # Snapshotted so the over-half judgement stays auditable once stock
            # has moved on.
            "lender_on_hand": on_hand,
        })

    doc.flags.ignore_links = True
    doc.insert(ignore_permissions=True)

    _notify_lender_of_request(doc, over_half)
    frappe.db.commit()
    return {"name": doc.name, "over_half": over_half}


def _notify_lender_of_request(doc, over_half: list) -> None:
    lender_users = users_for_farm(doc.lender_farm)
    lines = ", ".join(f"{i.requested_qty:g} {i.uom} {i.item_name}" for i in doc.items)
    subject = f"{doc.requesting_farm} would like to borrow from {doc.lender_farm}"
    body = f"{lines}." + (f" Reason: {doc.reason}" if doc.reason else "")
    if over_half:
        # Deliberately gentle: the lender may well be happy to say yes, and this
        # is a heads-up rather than an objection.
        names = ", ".join(over_half)
        body += (
            f" Worth knowing: this is more than half your current stock of {names}."
        )
    notify(lender_users, subject, body, DOCTYPE, doc.name, category="loan")


@frappe.whitelist()
def decide_items(request: str, decisions) -> dict:
    """Lender decides each line: approve (optionally less), or reject.

    ``decisions`` = ``[{item_code, status, approved_qty}]``. Approving anything
    raises ONE Material Transfer Stock Entry for every approved line together.
    """
    _ensure_enabled()
    _ensure_creator()
    doc = frappe.get_doc(DOCTYPE, request)
    _assert_lender(doc)

    decisions = _as_list(decisions)
    if isinstance(decisions, dict):
        decisions = decisions.get("decisions") or []
    by_code = {(d.get("item_code") or "").strip(): d for d in decisions}

    approved = []
    for row in doc.items:
        d = by_code.get(row.item_code)
        if not d:
            continue
        status = (d.get("status") or "").strip().title()
        if status not in ("Approved", "Rejected"):
            frappe.throw(f"{row.item_code}: decision must be Approved or Rejected.")
        row.status = status
        row.decided_by = frappe.session.user
        row.decided_on = now_datetime()
        if status == "Approved":
            qty = flt(d.get("approved_qty") or row.requested_qty)
            if qty <= 0:
                frappe.throw(f"{row.item_code}: approved quantity must be positive.")
            if qty > flt(row.requested_qty):
                frappe.throw(
                    f"{row.item_code}: cannot approve more than the {row.requested_qty:g} requested."
                )
            on_hand = item_on_hand(doc.lender_farm, row.item_code)
            if qty > on_hand:
                frappe.throw(
                    f"{row.item_code}: only {on_hand:g} on hand now; cannot release {qty:g}."
                )
            row.approved_qty = qty
            approved.append(row)
        else:
            row.approved_qty = 0

    se_name = _transfer_approved(doc, approved) if approved else None

    statuses = {r.status for r in doc.items}
    if statuses == {"Rejected"}:
        doc.workflow_state = "Rejected"
    elif "Pending" in statuses:
        doc.workflow_state = "Pending Approval"
    else:
        doc.workflow_state = "Fulfilled"

    doc.flags.ignore_links = True
    doc.save(ignore_permissions=True)

    _notify_requester_of_decision(doc, se_name)
    frappe.db.commit()
    return {"name": doc.name, "state": doc.workflow_state, "stock_entry": se_name}


def _company_cost_center(company: str) -> str | None:
    """The company's default cost center.

    Needed as a fallback because Cost Center is mandatory on Stock Entry items on
    this site, and `match_cost_center` legitimately returns nothing for a
    warehouse with no explicit or name-matched center. Without this the transfer
    throws at submit and the approval is lost.
    """
    if not company:
        return None
    return frappe.db.get_value("Company", company, "cost_center") or frappe.db.get_value(
        "Cost Center", {"company": company, "is_group": 0}, "name"
    )


def _transfer_approved(doc, rows) -> str:
    """One Material Transfer covering every approved line.

    Warehouses are set PER ROW, not on the header: a request may mix chemicals and
    foliars, and those live in different stores at both ends. A header pair would
    silently route a foliar into a chemical store.
    """
    se = frappe.new_doc("Stock Entry")
    se.stock_entry_type = SE_TYPE_LOAN
    se.purpose = "Material Transfer"
    se.company = frappe.db.get_value("Warehouse", doc.lender_warehouse, "company")

    # Belt and braces: a request raised before the cross-company check existed
    # would otherwise fail deep inside ERPNext with a warehouse/company error.
    borrower_co = farm_company(doc.requesting_farm)
    if borrower_co and se.company and borrower_co != se.company:
        frappe.throw(
            f"{doc.requesting_farm} belongs to {borrower_co}, {doc.lender_farm} to "
            f"{se.company}. A single transfer cannot cross companies."
        )

    fallback_cc = _company_cost_center(se.company)
    for row in rows:
        src = store_for(doc.lender_farm, row.item_code)
        dst = store_for(doc.requesting_farm, row.item_code)
        if not src or not dst:
            kind = item_kind(row.item_code)
            frappe.throw(
                f"{row.item_code} is a {kind}; "
                f"{'both farms need' if not src and not dst else (doc.lender_farm if not src else doc.requesting_farm) + ' needs'}"
                f" a {'fertilizer' if kind == 'foliar' else 'chemical'} store."
            )
        item = {
            "item_code": row.item_code,
            "qty": flt(row.approved_qty),
            "uom": row.uom or frappe.db.get_value("Item", row.item_code, "stock_uom"),
            "conversion_factor": 1,
            "s_warehouse": src,
            "t_warehouse": dst,
        }
        cc = match_cost_center(src) or fallback_cc
        if cc:
            item["cost_center"] = cc
        se.append("items", item)

    se.flags.ignore_links = True
    se.insert(ignore_permissions=True)
    se.submit()
    for row in rows:
        row.stock_entry = se.name
    return se.name


def _notify_requester_of_decision(doc, se_name) -> None:
    ok = [r for r in doc.items if r.status == "Approved"]
    no = [r for r in doc.items if r.status == "Rejected"]
    parts = []
    if ok:
        parts.append(
            "approved " + ", ".join(f"{r.approved_qty:g} {r.uom} {r.item_name}" for r in ok)
        )
    if no:
        parts.append("declined " + ", ".join(r.item_name for r in no))
    if not parts:
        return
    subject = f"{doc.lender_farm} {' and '.join(parts)}"
    body = (
        f"Request {doc.name} to {doc.lender_farm}."
        + (f" Stock Entry {se_name}." if se_name else "")
        + (f" {doc.rejected_reason}" if doc.rejected_reason else "")
    )
    # The requesting planner who raised it, plus their farm's people.
    audience = set(users_for_farm(doc.requesting_farm)) | {doc.owner}
    notify(sorted(audience), subject, body, DOCTYPE, doc.name, category="loan")


@frappe.whitelist()
def reject_whole_request(request: str, reason: str | None = None) -> dict:
    """Decline every pending line in one action."""
    _ensure_enabled()
    _ensure_creator()
    doc = frappe.get_doc(DOCTYPE, request)
    _assert_lender(doc)
    for row in doc.items:
        if row.status == "Pending":
            row.status = "Rejected"
            row.approved_qty = 0
            row.decided_by = frappe.session.user
            row.decided_on = now_datetime()
    doc.rejected_reason = (reason or "").strip() or None
    doc.workflow_state = "Rejected"
    doc.flags.ignore_links = True
    doc.save(ignore_permissions=True)
    _notify_requester_of_decision(doc, None)
    frappe.db.commit()
    return {"name": doc.name, "state": doc.workflow_state}


def _assert_lender(doc) -> None:
    """Only the addressed farm may decide — and elevated roles for support."""
    if set(frappe.get_roles(frappe.session.user)) & ELEVATED:
        return
    allowed = _user_farms() or set()
    if doc.lender_farm not in allowed:
        frappe.throw(
            f"Only {doc.lender_farm} can decide this request.", frappe.PermissionError
        )


# ─────────────────────────── privacy enforcement ─────────────────────────────


def permission_query(user=None):
    """Row-level visibility for Chemical Transfer Request.

    A planner sees only requests their farms raised or were asked for. Enforced
    here rather than in the UI, so the rows are unreadable over the REST API too.
    """
    user = user or frappe.session.user
    if set(frappe.get_roles(user)) & ELEVATED:
        return ""
    farms = _user_farms(user)

    # A request drawn from the general store has no lender farm — the keeper of
    # that store is the one who decides it, so they must be able to see it. Their
    # own farms' requests still reach them through the farm clause below.
    stores = frappe.get_all(
        "Farm Store Keeper", filters={"user": user}, pluck="warehouse"
    )
    pool = [s for s in stores if s]
    pool_clause = ""
    if pool:
        quoted_stores = ", ".join(frappe.db.escape(s) for s in sorted(set(pool)))
        pool_clause = (
            f"(`tabChemical Transfer Request`.from_general_store = 1 "
            f"and `tabChemical Transfer Request`.lender_warehouse in ({quoted_stores}))"
        )

    if farms is None:
        return ""
    if not farms:
        return pool_clause or "1=0"
    quoted = ", ".join(frappe.db.escape(f) for f in sorted(farms))
    farm_clause = (
        f"(`tabChemical Transfer Request`.requesting_farm in ({quoted}) "
        f"or `tabChemical Transfer Request`.lender_farm in ({quoted}))"
    )
    return f"({farm_clause} or {pool_clause})" if pool_clause else farm_clause
