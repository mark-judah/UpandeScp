"""Create this app's Custom Fields idempotently — deploy-proof.

These fields used to ship as a ``Custom Field`` fixture. Fixture import does a
plain insert and aborts the WHOLE migrate on the first conflict — e.g. a field
whose column already exists on the site but has no Custom Field doc (mona-native
biometric fields, the framework ``workflow_state``, …). One such field broke
every deploy.

This patch reads the same definitions from ``fixtures/custom_field.json`` and
creates only the *missing* ones via ``create_custom_fields`` (which syncs the
column idempotently). Fields that already exist are left untouched, and each
creation is isolated so a single bad field can never abort the deploy. Safe to
re-run.
"""
from __future__ import annotations

import json

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

# Doc bookkeeping keys that must not be fed into create_custom_fields.
_DROP = {
    "name", "owner", "creation", "modified", "modified_by", "docstatus", "idx",
    "doctype", "parent", "parentfield", "parenttype",
    "_user_tags", "_comments", "_assign", "_liked_by",
}


def execute() -> None:
    path = frappe.get_app_path("upande_scp", "fixtures", "custom_field.json")
    try:
        with open(path) as fh:
            defs = json.load(fh)
    except (OSError, ValueError):
        return

    for d in defs:
        dt = d.get("dt")
        fieldname = d.get("fieldname")
        if not dt or not fieldname:
            continue
        # Already a managed Custom Field → leave it exactly as-is. This is the
        # whole point: an existing field never re-runs through column creation,
        # so it can't raise "field already exists" and break the deploy.
        if frappe.db.exists("Custom Field", f"{dt}-{fieldname}"):
            continue
        field = {k: v for k, v in d.items() if k not in _DROP}
        try:
            create_custom_fields({dt: [field]}, ignore_validate=True)
            frappe.db.commit()
        except Exception:
            # Don't let one odd field (e.g. a column that exists without a doc
            # on some site) abort the migrate — record it and keep going.
            frappe.db.rollback()
            frappe.log_error(
                frappe.get_traceback(),
                f"ensure_scp_custom_fields: {dt}-{fieldname}",
            )
    frappe.db.commit()
