"""Point the crop-protection classifier at mona's real Item Groups.

The groups are resolved through the Item Group table rather than written as
literals: MariaDB's collation is case-insensitive, so seeding "Chemicals" can
silently match an existing "CHEMICALS" and create a duplicate config row.

This is the fix for the defect that kept foliars out of the spray flow — the
picker hardcoded ["CHEMICALS", "Fertilizer"], and mona's groups are "Chemicals"
and "Fertilizers". Collation forgave the first mismatch; it did not forgive the
second, so all 26 foliar items were invisible.
"""
from __future__ import annotations

import frappe

WANTED = {"chemical_item_groups": "Chemicals", "foliar_item_groups": "Fertilizers"}


def execute():
    settings = frappe.get_single("Spray Plan Settings")
    changed = False
    for field, wanted in WANTED.items():
        resolved = frappe.db.get_value("Item Group", {"name": wanted}, "name")
        if not resolved:
            frappe.log_error(
                f"Item Group {wanted!r} not found",
                "configure_crop_protection_item_groups",
            )
            continue
        existing = {r.item_group for r in (settings.get(field) or [])}
        if resolved in existing:
            continue
        settings.append(field, {"item_group": resolved})
        changed = True
    if changed:
        settings.save(ignore_permissions=True)
