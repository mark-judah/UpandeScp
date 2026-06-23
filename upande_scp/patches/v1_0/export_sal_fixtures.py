"""Flip Spray Application Logsheet + child doctypes from custom=1 to custom=0
so Frappe's JSON-based migrate takes over the schema. Idempotent.

In Part A these doctypes existed only as Custom DocTypes in the DB. In Part B
they are committed to the repo as standard JSON files under
upande_scp/upande_scp/doctype/. Frappe's import_file refuses to overwrite a
DocType that still has custom=1, so this patch flips the flag once and lets
the regular sync take it from there.
"""
import frappe

DOCTYPES = (
    "Spray Application Logsheet",
    "Spray Application Pesticide",
    "Spray Application Applicator",
)


def execute():
    for dt in DOCTYPES:
        if not frappe.db.exists("DocType", dt):
            continue
        if frappe.db.get_value("DocType", dt, "custom"):
            frappe.db.set_value("DocType", dt, "custom", 0, update_modified=False)
