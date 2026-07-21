"""Create the named Stock Entry Types used by the spray flow.

Idempotent: creates each type if missing, and keeps `purpose` in sync if a
type by this name already exists (e.g. re-run after a name was reused).
Renaming these types (spray_stock_types.py) does not change `purpose` — all
downstream purpose-based dispatch is unaffected.
"""

import frappe

from upande_scp.serverscripts.store.spray_stock_types import SPRAY_STOCK_ENTRY_TYPES


def execute():
    for type_name, purpose in SPRAY_STOCK_ENTRY_TYPES.items():
        if frappe.db.exists("Stock Entry Type", type_name):
            # keep purpose in sync in case a name was reused
            frappe.db.set_value("Stock Entry Type", type_name, "purpose", purpose)
            continue
        doc = frappe.new_doc("Stock Entry Type")
        doc.name = type_name
        doc.purpose = purpose
        doc.is_standard = 0
        doc.insert(ignore_permissions=True)
    frappe.db.commit()
