# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document

from upande_scp.serverscripts.common.warehouse_classify import (
    is_chemical_store,
    is_fertilizer_store,
)


class SprayPlanSettings(Document):
    pass


def get_allowed_farms():
    """Return the list of farm names enabled in Spray Plan Settings."""
    farms = frappe.get_all(
        "Spray Plan Allowed Farm",
        filters={"parenttype": "Spray Plan Settings"},
        pluck="farm",
    )
    return [f for f in farms if f]


def _allowed_warehouses_matching(predicate):
    """Non-disabled Warehouse names whose name satisfies ``predicate`` and that
    are in scope for the allowed farms. Empty when no farms are configured.

    A warehouse is in scope when its ``custom_farm`` is one of the allowed
    farms, OR it has no ``custom_farm`` set (NULL/blank → treated as global).
    The operational stores and CSUs on single-farm sites (e.g. mona's
    "Chemical Main Store - MFK" / "Main CSU A - MFK") are untagged, so a
    strict ``custom_farm IN farms`` filter hid them and starved the chemical-
    source picker. This mirrors the "NULL farm = global" convention the
    spray-team query already uses; a store tagged to a *different* farm stays
    hidden."""
    farms = get_allowed_farms()
    if not farms:
        return []
    farms_set = set(farms)
    rows = frappe.get_all(
        "Warehouse",
        filters={"disabled": 0},
        fields=["name", "custom_farm"],
        order_by="name asc",
    )
    out = []
    for r in rows:
        name = r.get("name")
        if not predicate(name):
            continue
        farm = r.get("custom_farm")
        # NULL/blank farm = global; otherwise it must be one of the user's farms.
        if farm and farm not in farms_set:
            continue
        out.append(name)
    return out


def _configured_stores(fieldname):
    """Non-disabled warehouses explicitly listed in the given Spray Plan Settings
    child table (``chemical_stores`` / ``fertigation_stores``). The admin's
    explicit choice wins as-is — no farm scoping — so a deliberately picked
    global store (e.g. an untagged main store) is always honoured. Returns [] when
    nothing is configured, so callers can fall back to the name heuristic."""
    rows = frappe.get_all(
        "Spray Plan Store Warehouse",
        filters={"parenttype": "Spray Plan Settings", "parentfield": fieldname},
        pluck="warehouse",
    )
    names = [w for w in rows if w]
    if not names:
        return []
    live = set(
        frappe.get_all(
            "Warehouse",
            filters={"name": ["in", names], "disabled": 0},
            pluck="name",
        )
    )
    # Preserve the configured order, drop any disabled/deleted ones.
    return [w for w in names if w in live]


def get_allowed_chemical_store_warehouses():
    """Chemical-store warehouses. Prefers the explicit Spray Plan Settings list;
    falls back to the ``chemical … store`` name heuristic when unset."""
    return _configured_stores("chemical_stores") or _allowed_warehouses_matching(
        is_chemical_store
    )


def get_allowed_fertilizer_unit_warehouses():
    """Fertigation / foliar warehouses. Prefers the explicit Spray Plan Settings
    list; falls back to the ``fertilizer … store`` name heuristic when unset."""
    return _configured_stores("fertigation_stores") or _allowed_warehouses_matching(
        is_fertilizer_store
    )
