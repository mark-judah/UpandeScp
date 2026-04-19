"""
Backfill existing Scouting Entry rows with crop_scouted = "Rose".

Creates a "Rose" Crop Scouted master (if missing) and populates its
Pests / Diseases / Predators / Weeds / Incidents / Physiological Disorders / Traps
multi-select tables with every existing master row, so existing entries remain
unfiltered after the crop scope rule takes effect on the form.

Then sets crop_scouted = "Rose" on all Scouting Entry rows where it is empty.

USAGE (bench console)
---------------------
exec(open('/home/ubuntu/stive/code/frappe15/apps/upande_scp/backfill_crop_scouted_rose.py').read())
"""

import frappe

EXECUTE = True
CROP_NAME = "Rose"

CATEGORY_TABLES = [
	("pests", "pest", "Pest"),
	("diseases", "disease", "Plant Disease"),
	("predators", "predator", "Predator"),
	("weeds", "weed", "Weed"),
	("incidents", "incident", "Incident"),
	("physiological_disorders", "physiological_disorder", "Physiological Disorder"),
	("traps", "trap", "Trap"),
]


def _ensure_rose():
	if frappe.db.exists("Crop Scouted", CROP_NAME):
		crop = frappe.get_doc("Crop Scouted", CROP_NAME)
		print("Found existing Crop Scouted: %s" % CROP_NAME)
	else:
		crop = frappe.get_doc({"doctype": "Crop Scouted", "crop_name": CROP_NAME})
		crop.insert(ignore_permissions=True)
		print("Created Crop Scouted: %s" % CROP_NAME)

	for crop_field, link_field, master_doctype in CATEGORY_TABLES:
		existing = {row.get(link_field) for row in (crop.get(crop_field) or [])}
		masters = frappe.get_all(master_doctype, pluck="name")
		added = 0
		for m in masters:
			if m in existing:
				continue
			crop.append(crop_field, {link_field: m})
			added += 1
		print("  %-28s existing=%d  added=%d  total_masters=%d" % (
			crop_field, len(existing), added, len(masters),
		))

	crop.save(ignore_permissions=True)
	return crop.name


def _backfill_entries(crop_name):
	count = frappe.db.count("Scouting Entry", {"crop_scouted": ["is", "not set"]})
	print("\nScouting Entry rows with empty crop_scouted: %d" % count)
	if not count:
		return 0

	frappe.db.sql(
		"""
		UPDATE `tabScouting Entry`
		SET crop_scouted = %s
		WHERE crop_scouted IS NULL OR crop_scouted = ''
		""",
		(crop_name,),
	)
	return count


if not EXECUTE:
	print("[DRY RUN] Set EXECUTE = True to commit.")
else:
	_crop = _ensure_rose()
	_updated = _backfill_entries(_crop)
	frappe.db.commit()

	print("")
	print("=" * 60)
	print("DONE")
	print("  Crop Scouted    : %s" % _crop)
	print("  Entries updated : %d" % _updated)
	print("=" * 60)
