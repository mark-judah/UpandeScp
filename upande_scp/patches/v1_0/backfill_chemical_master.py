"""Backfill the Chemical master from existing Item chemical metadata.

Creates one ``Chemical`` per Item in the "Chemicals" group, copying the legacy
``custom_*`` fields/child tables (targets, active ingredients, IRAC/FRAC/GHS,
type, toxicity, re-entry, rates). The child doctypes are shared with Item, so
rows copy verbatim. ``allowed`` follows the Item's disabled flag (a disabled
chemical is not allowed). Idempotent and failure-isolated.
"""
from __future__ import annotations

import frappe

SCALAR_MAP = {
    "type": "custom_type",
    "toxicity": "custom_toxicity",
    "reentry_interval_hrs": "custom_reentry_interval_hrs",
    "application_rate": "custom_application_rate",
    "lower_rate_limit": "custom_lower_rate_limit",
    "upper_rate_limit": "custom_upper_rate_limit",
    "pack_rate": "custom_pack_rate",
}
CHILD_MAP = {
    "targets": "custom_targets",
    "active_ingredients": "custom_active_ingredients",
    "irac": "custom_irac",
    "frac": "custom_frac",
    "ghs": "custom_ghs",
}
_DROP = {
    "name", "parent", "parentfield", "parenttype", "idx", "docstatus",
    "owner", "creation", "modified", "modified_by", "doctype",
}


def execute() -> None:
    if not frappe.db.table_exists("Chemical"):
        return
    codes = frappe.get_all("Item", filters={"item_group": "Chemicals"}, fields=["name", "disabled"])
    for row in codes:
        code = row["name"]
        if frappe.db.exists("Chemical", code):
            continue
        try:
            item = frappe.get_doc("Item", code)
            chem = frappe.new_doc("Chemical")
            chem.item = code
            chem.allowed = 0 if item.get("disabled") else 1
            for cf, icf in SCALAR_MAP.items():
                chem.set(cf, item.get(icf))
            for cf, icf in CHILD_MAP.items():
                for src in (item.get(icf) or []):
                    chem.append(cf, {k: v for k, v in src.as_dict().items() if k not in _DROP})
            chem.insert(ignore_permissions=True)
            frappe.db.commit()
        except Exception:
            frappe.db.rollback()
            frappe.log_error(frappe.get_traceback(), f"backfill_chemical_master: {code}")
    frappe.db.commit()
