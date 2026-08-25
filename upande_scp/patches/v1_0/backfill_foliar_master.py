"""Create one `Foliar` sidecar per Item in the configured foliar groups.

The `after_insert` hook covers items added from now on; this covers the ones
already on the site. Delegates to `crop_protection.ensure_product_record` so the
creation rules live in one place.

Idempotent and failure-isolated.
"""
from __future__ import annotations

import frappe

from upande_scp.serverscripts.common import crop_protection


def execute():
    groups = list(crop_protection.product_groups("foliar"))
    if not groups:
        return
    items = frappe.get_all(
        "Item", filters={"item_group": ["in", groups], "disabled": 0}, pluck="name"
    )
    for code in items:
        if crop_protection.is_foliar(code):
            continue
        try:
            crop_protection.ensure_product_record(code)
        except Exception:
            frappe.log_error(frappe.get_traceback(), f"backfill_foliar_master: {code}")
