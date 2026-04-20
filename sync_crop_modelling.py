"""
Sync the Crop Modelling changes:

  - New doctype: Tree (replaces the "trees are Zones" pattern)
  - New child doctype: Crop Modelling Entry
  - Updated Scouting Entry (adds crop_modelling_entry child table, tree Link
    now points at Tree)

Skips a full `bench migrate` to avoid the unrelated Sampling Table schema
conflict. Imports each doctype JSON directly.

USAGE  (bench console)
----------------------
exec(open('/home/ubuntu/stive/code/frappe15/apps/upande_scp/sync_crop_modelling.py').read())
"""

import frappe
from frappe.modules.import_file import import_file_by_path

APP_BASE = "/home/ubuntu/stive/code/frappe15/apps/upande_scp/upande_scp/upande_scp/doctype"

DOCTYPES = [
    "tree",
    "crop_modelling_entry",
    "scouting_entry",
]

for dt in DOCTYPES:
    path = f"{APP_BASE}/{dt}/{dt}.json"
    print(f"Importing {path}...")
    import_file_by_path(path, force=True, reset_permissions=False)

frappe.db.commit()

print("")
print("=" * 60)
print("DONE - crop modelling doctypes synced")
print("=" * 60)
