"""
Seed script — plant sections filter
  1. Re-sync Plant Section Filter + Crop Scouted doctypes
  2. Ensure Plant Section records for Leaf and Fruit exist
  3. Tag Rose: Stem, Base, Middle, Top, Buds, Leaf, Fruit
  4. Tag Avocado: Stem, Fruit, Leaf

USAGE
-----
exec(open('/home/ubuntu/stive/code/frappe15/apps/upande_scp/seed_plant_sections.py').read())
"""

import frappe
from frappe.modules.import_file import import_file_by_path

_APP_BASE = "/home/ubuntu/stive/code/frappe15/apps/upande_scp/upande_scp/upande_scp/doctype"

print("[1/4] Re-syncing Plant Section Filter + Crop Scouted...")
for _dt in ["plant_section_filter", "crop_scouted"]:
	import_file_by_path(f"{_APP_BASE}/{_dt}/{_dt}.json", force=True, reset_permissions=False)

print("\n[2/4] Ensuring Plant Section records for Leaf, Fruit...")
for _name in ["Leaf", "Fruit"]:
	if frappe.db.exists("Plant Section", _name):
		print(f"  {_name} exists")
	else:
		frappe.get_doc({"doctype": "Plant Section", "section": _name}).insert(
			ignore_permissions=True
		)
		print(f"  {_name} created")

_ROSE_SECTIONS = ["Stem", "Base", "Middle", "Top", "Buds", "Leaf", "Fruit"]
_AVOCADO_SECTIONS = ["Stem", "Fruit", "Leaf"]


def _tag_crop(crop_name, section_list):
	if not frappe.db.exists("Crop Scouted", crop_name):
		print(f"  {crop_name} missing — skipping")
		return
	crop = frappe.get_doc("Crop Scouted", crop_name)
	existing = {row.plant_section for row in (crop.get("plant_sections_scouted") or [])}
	added = 0
	for s in section_list:
		if s in existing:
			continue
		crop.append("plant_sections_scouted", {"plant_section": s})
		added += 1
	crop.save(ignore_permissions=True)
	print(f"  {crop_name}: {len(section_list)} target, {added} added")


print("\n[3/4] Tagging Rose...")
_tag_crop("Rose", _ROSE_SECTIONS)

print("\n[4/4] Tagging Avocado...")
_tag_crop("Avocado", _AVOCADO_SECTIONS)

frappe.db.commit()

print("")
print("=" * 60)
print("DONE")
print("=" * 60)
