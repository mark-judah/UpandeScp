"""Shared loaning helpers, stock baselines, and request expiry.

The request/approve flow that used to live here has been REPLACED by
``loaning_v2`` — directed, multi-item, per-line decisions. The superseded
endpoints (create_request, approve_source, get_sources_for, list_requests,
get_creditors, validate_source_split and friends) are deleted rather than
deprecated: nothing under ``serverscripts/mobile`` ever referenced them, and the
web client no longer does either.

What remains and is still live:

* the scope/permission helpers ``loaning_v2`` builds on;
* ``my_farms``, which the page still uses to pick the acting farm;
* ``Chemical Stock Baseline`` capture (a doc hook on Stock Entry) and
  ``bulk_restock``, which are about baselines rather than loans;
* ``expire_dormant_requests``, the scheduled sweep.

The ``Chemical Transfer Request Source`` child table is deliberately NOT dropped.
It holds the historical split for requests raised under the old model — including
one spread across two lenders — and that is data, not dead code.
"""
from __future__ import annotations

import json
from typing import Any

import frappe

from upande_scp.serverscripts.common import crop_scope
from upande_scp.serverscripts.common import stores
from frappe.utils import add_to_date, flt, get_datetime, now_datetime

from upande_scp.serverscripts.common.crop_protection import product_groups
from upande_scp.serverscripts.common.notifications import notify
from upande_scp.serverscripts.spray_plan_creator.scope import _resolve_user_scope
from upande_scp.serverscripts.spray_plan_creator.validation import match_cost_center
from upande_scp.serverscripts.store.spray_stock_types import SE_TYPE_LOAN

ELEVATED = {"SCP General Manager", "System Manager", "Administrator"}
CREATOR_ROLES = {"SCP Spray Plan Creator"} | ELEVATED
MAX_SOURCES = 5
QTY_TOL = 0.001


# ───────────────────────────── guards / scope ────────────────────────────────


def _settings():
    return frappe.get_single("Scouting and Crop Protection Settings")


def _ensure_enabled():
    s = _settings()
    if not s.loaning_enabled:
        frappe.throw(
            "Chemical loaning is not enabled. Ask the SCP General Manager to turn "
            "it on in Settings → Spray Plan.",
        )
    return s


def _ensure_creator():
    if not (set(frappe.get_roles(frappe.session.user)) & CREATOR_ROLES):
        frappe.throw(
            "Chemical loaning requires the SCP Spray Plan Creator role.",
            frappe.PermissionError,
        )


def _user_farms(user: str | None = None) -> set[str] | None:
    """Farms the user may act for, or None for unscoped.

    Unscoped is now Administrator and System Manager only. `ELEVATED` includes
    `SCP General Manager`, and using it here meant a GM borrowed for, and lent
    from, every farm on the site regardless of company — the "I can see all
    farms in all perspectives" report. A general manager belongs to a company
    like anyone else (see `crop_scope.BYPASS_ROLES`).
    """
    user = user or frappe.session.user
    return crop_scope.visible_farms(
        roster_field="spray_plan_creators", user=user
    )


def _assert_farm_access(farm: str) -> None:
    allowed = _user_farms()
    if allowed is None:
        return
    if farm not in allowed:
        frappe.throw(
            f"You are not assigned to {farm}.", frappe.PermissionError
        )


# ───────────────────────────── stock primitives ──────────────────────────────


def _farm_chemical_stores(farm: str) -> list[str]:
    """Delegates to `common.stores`, which prefers `Farm.custom_chemical_store`
    over the warehouse-name convention. This function used to do the name match
    only, so a farm with a correctly mapped but unconventionally named store was
    treated as having no stock at all."""
    return stores.farm_stores(farm, "chemical")


def _primary_store(farm: str) -> str | None:
    return stores.primary_store(farm, "chemical")


def _on_hand(farm: str, item_code: str) -> float:
    stores = _farm_chemical_stores(farm)
    if not stores:
        return 0.0
    row = frappe.db.sql(
        """SELECT COALESCE(SUM(actual_qty), 0) AS q FROM `tabBin`
           WHERE item_code = %s AND warehouse IN %s""",
        (item_code, tuple(stores)),
        as_dict=True,
    )
    return flt(row[0]["q"]) if row else 0.0


def _all_chemical_farms() -> list[str]:
    return sorted(stores.farms_with_stores())


# ───────────────────────────────── reads ─────────────────────────────────────


@frappe.whitelist()
def my_farms() -> dict:
    """Farms the current user may request for + feature flag, for the page.

    An unscoped user (Administrator / System Manager) still gets the full list;
    everyone else gets the farms they are rostered on within their company.
    """
    _ensure_creator()
    allowed = _user_farms()
    farms = _all_chemical_farms() if allowed is None else sorted(allowed)
    return {"farms": farms, "enabled": bool(_settings().loaning_enabled)}


# ──────────────────────────────── writes ─────────────────────────────────────


# ───────────────────────────── baselines / restock ───────────────────────────


def capture_baseline_on_receipt(doc, method=None):
    """Hooked on inbound stock movements. When chemicals are received into a
    farm's chemical store, set that (farm, chemical) baseline to the new
    on-hand. Tolerant of doc shape (Stock Entry / Purchase Receipt)."""
    try:
        if not _settings().loaning_enabled:
            return
    except Exception:
        return

    # Collect (warehouse, item_code) pairs that received stock.
    pairs: set[tuple[str, str]] = set()
    for it in (getattr(doc, "items", None) or []):
        wh = getattr(it, "t_warehouse", None) or getattr(it, "warehouse", None)
        code = getattr(it, "item_code", None)
        if wh and code:
            pairs.add((wh, code))

    for wh, code in pairs:
        farm = frappe.db.get_value("Warehouse", wh, "custom_farm")
        if not farm:
            continue
        # Was a name test; now the farm's actual chemical stores, so a mapped
        # store with an unconventional name still captures a baseline.
        if wh not in stores.farm_stores(farm, "chemical"):
            continue
        group = frappe.db.get_value("Item", code, "item_group")
        if group not in product_groups():
            continue
        _upsert_baseline(farm, code, _on_hand(farm, code), "restock")


def _upsert_baseline(farm: str, item_code: str, qty: float, via: str) -> None:
    name = f"{farm}::{item_code}"
    if frappe.db.exists("Chemical Stock Baseline", name):
        frappe.db.set_value("Chemical Stock Baseline", name, {
            "baseline_qty": qty,
            "captured_on": now_datetime(),
            "captured_via": via,
        }, update_modified=True)
    else:
        b = frappe.new_doc("Chemical Stock Baseline")
        b.farm = farm
        b.item_code = item_code
        b.item_name = frappe.db.get_value("Item", item_code, "item_name")
        b.baseline_qty = qty
        b.captured_on = now_datetime()
        b.captured_via = via
        b.insert(ignore_permissions=True)


@frappe.whitelist()
def bulk_restock(farm: str | None = None) -> dict:
    """GM utility: set every (farm, chemical) baseline to current on-hand."""
    if not (set(frappe.get_roles(frappe.session.user)) & ELEVATED):
        frappe.throw("Only the SCP General Manager can bulk-restock.", frappe.PermissionError)

    farms = [farm] if farm else _all_chemical_farms()
    groups = product_groups()
    updated = 0
    for f in farms:
        stores = _farm_chemical_stores(f)
        if not stores or not groups:
            continue
        rows = frappe.db.sql(
            """SELECT b.item_code, COALESCE(SUM(b.actual_qty),0) q
               FROM `tabBin` b JOIN `tabItem` i ON i.name=b.item_code
               WHERE b.warehouse IN %s AND i.item_group IN %s AND b.actual_qty > 0
               GROUP BY b.item_code""",
            (tuple(stores), groups),
            as_dict=True,
        )
        for r in rows:
            _upsert_baseline(f, r.item_code, flt(r.q), "bulk_restock")
            updated += 1
    frappe.db.commit()
    return {"farms": len(farms), "baselines_set": updated}


# ───────────────────────────────── timeout job ───────────────────────────────


def expire_dormant_requests() -> dict:
    """Hourly: expire Pending Approval requests past their timeout."""
    try:
        if not _settings().loaning_enabled:
            return {"enabled": False, "expired": []}
    except Exception:
        return {"enabled": False, "expired": []}

    now = now_datetime()
    pending = frappe.get_all(
        "Chemical Transfer Request",
        filters={"workflow_state": "Pending Approval"},
        fields=["name", "expires_on", "owner", "item_name"],
    )
    expired = []
    for r in pending:
        if r.expires_on and get_datetime(r.expires_on) < now:
            try:
                frappe.db.set_value(
                    "Chemical Transfer Request", r.name, "workflow_state", "Expired"
                )
                _notify_user(
                    r.owner,
                    f"Chemical loan {r.name} expired",
                    f"Your request for {r.item_name} expired with no response.",
                    r.name,
                )
                frappe.db.commit()
                expired.append(r.name)
            except Exception:
                frappe.db.rollback()
                frappe.log_error(frappe.get_traceback(), f"expire_dormant_requests: {r.name}")
    return {"enabled": True, "expired": expired}


# ───────────────────────────────── notifications ─────────────────────────────


def _notify_farm_creators(farm: str, subject: str, content: str, ref: str) -> None:
    users = frappe.get_all(
        "Farm Spray Plan Creator",
        filters={"parent": farm, "parenttype": "Farm"},
        pluck="user",
    )
    for u in set(users):
        _notify_user(u, subject, content, ref)
    frappe.publish_realtime("chemical_loaning", {"request": ref}, after_commit=True)


def _notify_user(user: str | None, subject: str, content: str, ref: str) -> None:
    """Thin shim onto the shared notifier.

    Kept as a name because several call sites use it, but the implementation now
    lives in ``common/notifications.py``. Two notification paths would drift —
    and only one of them would ever gain realtime delivery or a category.
    """
    notify(
        [user] if user else [],
        subject,
        content,
        ref_doctype="Chemical Transfer Request",
        ref_name=ref,
        category="loan",
    )
