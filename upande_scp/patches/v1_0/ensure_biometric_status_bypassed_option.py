"""Add a "Bypassed" option to ``Stock Entry.biometric_status``.

When ``Spray Plan Settings.bypass_biometric_on_issue`` is ON, chemical issues
submitted without a live biometric scan are recorded with
``biometric_status = "Bypassed"`` (as opposed to Verified / Failed) so the
override is auditable. ``biometric_status`` is a mona-native Select Custom
Field; this appends the option idempotently so the value validates on save.

No-op on sites where the field doesn't exist or already has the option.
"""
from __future__ import annotations

import frappe

OPTION = "Bypassed"


def execute() -> None:
    # Look the field up by (dt, fieldname) — the Custom Field's *doc name* is
    # not necessarily "Stock Entry-biometric_status" (on mona it's the legacy
    # "Stock Entry-custom_verification_status"), but its fieldname is
    # ``biometric_status``.
    cf_name = frappe.db.get_value(
        "Custom Field", {"dt": "Stock Entry", "fieldname": "biometric_status"}, "name"
    )
    if not cf_name:
        return
    cf = frappe.get_doc("Custom Field", cf_name)
    if cf.fieldtype != "Select":
        return
    options = cf.options or ""
    if OPTION in [o.strip() for o in options.split("\n")]:
        return
    cf.options = options.rstrip("\n") + "\n" + OPTION
    cf.save()
    frappe.db.commit()
