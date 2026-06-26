# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document

from upande_scp.serverscripts.warehouse_classify import (
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
    """Non-disabled Warehouse names whose ``custom_farm`` is in the allowed-
    farms list and whose name satisfies ``predicate``. Empty when no farms
    are configured."""
    farms = get_allowed_farms()
    if not farms:
        return []
    rows = frappe.get_all(
        "Warehouse",
        filters={"custom_farm": ("in", farms), "disabled": 0},
        pluck="name",
        order_by="name asc",
    )
    return [name for name in rows if predicate(name)]


def get_allowed_chemical_store_warehouses():
    """Chemical-store warehouses scoped to allowed farms."""
    return _allowed_warehouses_matching(is_chemical_store)


def get_allowed_fertilizer_unit_warehouses():
    """Fertilizer-store warehouses scoped to allowed farms."""
    return _allowed_warehouses_matching(is_fertilizer_store)
