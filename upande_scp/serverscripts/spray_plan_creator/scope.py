# upande_scp/serverscripts/spray_plan_creator/scope.py
"""User-scope resolution helper.

`_resolve_user_scope(user)` is the single source of truth for what a
Spray Plan Creator can see. Every other endpoint runs its filters
through this helper.
"""
from __future__ import annotations

import frappe


def _resolve_user_scope(user: str) -> dict:
    """Return {farms, warehouses, greenhouses} for the given user.

    `farms`: names of Farms that list the user in their spray_plan_creators
             child table.
    `warehouses`: dicts of `{name, custom_farm, warehouse_name, warehouse_type}`
                  for every enabled Warehouse with custom_farm in the user's farms.
    `greenhouses`: subset of `warehouses` with warehouse_type='Greenhouse'.
    """
    farms = [row.parent for row in frappe.get_all(
        "Farm Spray Plan Creator",
        filters={"user": user, "parenttype": "Farm"},
        fields=["parent"],
    )]
    if not farms:
        return {"farms": [], "warehouses": [], "greenhouses": []}

    warehouses = frappe.get_all(
        "Warehouse",
        filters={"custom_farm": ["in", farms], "disabled": 0},
        fields=["name", "warehouse_name", "warehouse_type", "custom_farm"],
    )
    greenhouses = [w for w in warehouses if (w.get("warehouse_type") or "") == "Greenhouse"]
    return {"farms": farms, "warehouses": warehouses, "greenhouses": greenhouses}
