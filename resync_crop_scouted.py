"""
Re-sync the Crop Scouted doctype after removing the traps field, and drop
any stale Trap Filter rows that were left behind on the Rose record.

USAGE (bench console)
---------------------
exec(open('/home/ubuntu/stive/code/frappe15/apps/upande_scp/resync_crop_scouted.py').read())
"""

import frappe
from frappe.modules.import_file import import_file_by_path

_PATH = (
	"/home/ubuntu/stive/code/frappe15/apps/upande_scp/"
	"upande_scp/upande_scp/doctype/crop_scouted/crop_scouted.json"
)

print("Re-importing Crop Scouted from %s..." % _PATH)
import_file_by_path(_PATH, force=True, reset_permissions=False)

# Drop orphaned Trap Filter rows (they were pointing to Crop Scouted.traps).
_orphaned = frappe.db.sql(
	"""
	DELETE FROM `tabTrap Filter`
	WHERE parenttype = 'Crop Scouted'
	"""
)
frappe.db.commit()

print("Orphaned Trap Filter rows removed.")
print("=" * 60)
print("DONE — Crop Scouted re-synced without traps.")
print("=" * 60)
