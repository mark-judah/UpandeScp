"""
Sync only the Crop Scouted family of doctypes (+ the updated Scouting Entry).

Skips the full `bench migrate` because an unrelated app has a Sampling Table
schema conflict. This script imports the doctype JSON files directly so the new
master + 7 filter child doctypes land in the DB, plus the crop_scouted field on
Scouting Entry.

USAGE  (bench console)
----------------------
exec(open('/home/ubuntu/stive/code/frappe15/apps/upande_scp/sync_crop_doctypes.py').read())
"""

import frappe
from frappe.modules.import_file import import_file_by_path

APP_BASE = "/home/ubuntu/stive/code/frappe15/apps/upande_scp/upande_scp/upande_scp/doctype"

DOCTYPES = [
    "pest_filter",
    "disease_filter",
    "predator_filter",
    "weed_filter",
    "incident_filter",
    "physiological_disorder_filter",
    "trap_filter",
    "crop_scouted",
    "scouting_entry",
]

for dt in DOCTYPES:
    path = f"{APP_BASE}/{dt}/{dt}.json"
    print(f"Importing {path}...")
    import_file_by_path(path, force=True, reset_permissions=False)

frappe.db.commit()

print("")
print("=" * 60)
print("DONE — crop doctypes synced")
print("=" * 60)
