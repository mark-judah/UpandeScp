# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class ScoutingandCropProtectionSettings(Document):
    def validate(self):
        chem = {r.item_group for r in (self.chemical_item_groups or []) if r.item_group}
        fol = {r.item_group for r in (self.foliar_item_groups or []) if r.item_group}
        overlap = chem & fol
        if overlap:
            frappe.throw(
                "An Item Group cannot be both a Chemical and a Foliar group: "
                + ", ".join(sorted(overlap))
            )


def get_allowed_farms():
    """Return the list of farm names enabled in Scouting and Crop Protection Settings."""
    farms = frappe.get_all(
        "Spray Plan Allowed Farm",
        filters={"parenttype": "Scouting and Crop Protection Settings"},
        pluck="farm",
    )
    return [f for f in farms if f]


def _allowed_warehouses_by_prefix(prefix):
    """Return non-disabled Warehouse names whose ``custom_farm`` is in the
    Scouting and Crop Protection Settings allowed-farms list and whose name begins with
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
