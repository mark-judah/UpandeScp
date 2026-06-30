"""Single source for chemical spray-metadata, read from the `Chemical` master
with a fallback to the legacy Item ``custom_*`` fields.

The spray flow (picker gate, rate-limit + FRAC/IRAC validation, BOM, finances)
reads chemical metadata through here instead of touching Item directly, so the
`Chemical` doctype is the source of truth while old data still resolves until a
site is fully backfilled.
"""
from __future__ import annotations

import frappe
from frappe.utils import flt


def get_chemical(item_code: str | None) -> dict | None:
    """Metadata for one chemical item_code, or None if the item doesn't exist.

    Prefers the `Chemical` master; falls back to the Item custom fields when no
    Chemical row exists yet. ``allowed`` is True for ungated (no-row) items.
    """
    if not item_code:
        return None

    if frappe.db.exists("Chemical", item_code):
        c = frappe.get_doc("Chemical", item_code)
        return {
            "source": "chemical",
            "allowed": bool(c.allowed),
            "type": c.type,
            "toxicity": c.toxicity,
            "application_rate": flt(c.application_rate),
            "lower_rate_limit": flt(c.lower_rate_limit) or None,
            "upper_rate_limit": flt(c.upper_rate_limit) or None,
            "reentry_interval_hrs": flt(c.reentry_interval_hrs),
            "targets": [{"pest": t.pest, "disease": t.disease} for t in (c.targets or [])],
            "irac": [r.as_dict() for r in (c.irac or [])],
            "frac": [r.as_dict() for r in (c.frac or [])],
        }

    if not frappe.db.exists("Item", item_code):
        return None
    it = frappe.get_doc("Item", item_code)
    return {
        "source": "item",
        "allowed": True,  # no Chemical row → ungated
        "type": it.get("custom_type"),
        "toxicity": it.get("custom_toxicity"),
        "application_rate": flt(it.get("custom_application_rate")),
        "lower_rate_limit": flt(it.get("custom_lower_rate_limit")) or None,
        "upper_rate_limit": flt(it.get("custom_upper_rate_limit")) or None,
        "reentry_interval_hrs": flt(it.get("custom_reentry_interval_hrs")),
        "targets": [{"pest": t.pest, "disease": t.disease} for t in (it.get("custom_targets") or [])],
        "irac": [r.as_dict() for r in (it.get("custom_irac") or [])],
        "frac": [r.as_dict() for r in (it.get("custom_frac") or [])],
    }


def rate_limits(item_code: str | None) -> tuple[float | None, float | None]:
    """(lower, upper) application-rate limits for a chemical, or (None, None)."""
    c = get_chemical(item_code) or {}
    return c.get("lower_rate_limit"), c.get("upper_rate_limit")


def allowed_chemical_codes() -> set[str] | None:
    """Item codes whose `Chemical` is allowed. Returns None when there's no
    Chemical master at all (caller then treats every chemical as allowed)."""
    rows = frappe.get_all("Chemical", fields=["item", "allowed"])
    if not rows:
        return None
    return {r["item"] for r in rows if r["allowed"]}
