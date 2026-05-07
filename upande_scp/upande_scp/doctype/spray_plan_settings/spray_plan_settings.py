# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


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


def _allowed_warehouses_by_prefix(prefix):
    """Return non-disabled Warehouse names whose ``custom_farm`` is in the
    Spray Plan Settings allowed-farms list and whose name begins with
    ``prefix``. Empty when no farms are configured.
    """
    farms = get_allowed_farms()
    if not farms:
        return []
    rows = frappe.get_all(
        "Warehouse",
        filters={
            "name": ("like", f"{prefix} %"),
            "custom_farm": ("in", farms),
            "disabled": 0,
        },
        pluck="name",
        order_by="name asc",
    )
    return list(rows)


def get_allowed_chemical_store_warehouses():
    """Chemical-store warehouses scoped to allowed farms."""
    return _allowed_warehouses_by_prefix("Chemical Store")


def get_allowed_fertilizer_unit_warehouses():
    """Fertilizer-store warehouses scoped to allowed farms.

    Named ``..._unit_...`` for caller readability — the underlying
    Warehouse names use the ``Fertilizer Store`` prefix.
    """
    return _allowed_warehouses_by_prefix("Fertilizer Store")
