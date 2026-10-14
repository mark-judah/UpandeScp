"""Existing sites start in Warn for chemical targeting enforcement.

New sites default to Strict, but an existing site has product data still being filled in (on Mona, 66
of 83 chemicals have no registered target), so Strict would stop most plans at the Application Floor
Plan. Operations must never stop there: set Warn now, and the GM switches to Strict when the data is
ready. Idempotent: an explicit choice already stored is never overwritten."""
import frappe

SETTINGS = "Scouting and Crop Protection Settings"
FIELD = "chemical_targeting_mode"


def execute() -> None:
    stored = frappe.db.sql(
        "select value from `tabSingles` where doctype=%s and field=%s", (SETTINGS, FIELD)
    )
    if stored and stored[0][0] in ("Strict", "Warn"):
        return
    frappe.db.set_single_value(SETTINGS, FIELD, "Warn")
