"""
Create 4 missing Pest records (each with an Adult stage) and an Avocado
Crop Scouted that references them + the existing Scale Insects.

USAGE (bench console)
---------------------
exec(open('/home/ubuntu/stive/code/frappe15/apps/upande_scp/create_avocado_crop.py').read())
"""

import frappe

_CROP_NAME = "Avocado"

_NEW_PESTS = [
	"Leaf Rollers",
	"Mosquito Bugs",
	"Caterpillars",
	"Unidentified Insects",
]

# Existing pest we reuse
_REUSED_PESTS = ["Scale Insects"]


def _ensure_pest(name):
	if frappe.db.exists("Pest", name):
		pest = frappe.get_doc("Pest", name)
		has_adult = any(
			(row.stage or "").strip().lower() == "adult"
			for row in (pest.get("stages") or [])
		)
		if not has_adult:
			pest.append("stages", {"stage": "Adult", "reading_type": "Count"})
			pest.save(ignore_permissions=True)
			print("  %-24s existed — added Adult stage" % name)
		else:
			print("  %-24s existed — Adult stage present" % name)
		return

	pest = frappe.get_doc({
		"doctype": "Pest",
		"common_name": name,
		"stages": [{"stage": "Adult", "reading_type": "Count"}],
	})
	pest.insert(ignore_permissions=True)
	print("  %-24s created with Adult stage" % name)


# 1) Pest masters
print("Ensuring pests:")
for _n in _NEW_PESTS:
	_ensure_pest(_n)
for _n in _REUSED_PESTS:
	_ensure_pest(_n)

# 2) Avocado Crop Scouted
_all_pests = _NEW_PESTS + _REUSED_PESTS

if frappe.db.exists("Crop Scouted", _CROP_NAME):
	_crop = frappe.get_doc("Crop Scouted", _CROP_NAME)
	print("\nFound existing Crop Scouted: %s" % _CROP_NAME)
else:
	_crop = frappe.get_doc({"doctype": "Crop Scouted", "crop_name": _CROP_NAME})
	_crop.insert(ignore_permissions=True)
	print("\nCreated Crop Scouted: %s" % _CROP_NAME)

_existing_pest_links = {row.pest for row in (_crop.get("pests") or [])}
_added = 0
for _p in _all_pests:
	if _p in _existing_pest_links:
		continue
	_crop.append("pests", {"pest": _p})
	_added += 1

_crop.save(ignore_permissions=True)
frappe.db.commit()

print("  Pests tagged : %d (added %d)" % (len(_all_pests), _added))
print("  Diseases / Predators / Weeds / Incidents / Disorders : empty (sections hidden)")

print("")
print("=" * 60)
print("DONE — Avocado Crop Scouted ready")
print("=" * 60)
