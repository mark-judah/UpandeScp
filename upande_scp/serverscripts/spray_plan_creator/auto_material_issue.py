"""Auto-issue tank-mix on Manufacture Stock Entry submit.

When the Manufacture SE for an Application Floor Plan Work Order is submitted,
this handler atomically creates + submits a Material Issue SE that consumes
the manufactured tank-mix from the greenhouse warehouse. Workflow state advances
to ``Completed``.

The handler runs inside the same transaction as the Manufacture submit, so any
``frappe.throw`` here rolls the Manufacture submit back too.
"""
from __future__ import annotations

import frappe

AFP_TYPE = "Application Floor Plan"


def on_manufacture_submit(doc, method):
    """Stock Entry on_submit hook. No-op unless this is a Manufacture SE for
    an Application Floor Plan Work Order."""
    if getattr(doc, "purpose", None) != "Manufacture":
        return None
    work_order = getattr(doc, "work_order", None)
    if not work_order:
        return None

    wo_type = frappe.db.get_value("Work Order", work_order, "custom_type")
    if wo_type != AFP_TYPE:
        return None

    # Real work lands in subsequent tasks.
    return None
