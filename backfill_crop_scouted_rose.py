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

_EXECUTE = True
_CROP_NAME = "Rose"

_CATEGORY_TABLES = [
	("pests", "pest", "Pest"),
	("diseases", "disease", "Plant Disease"),
	("predators", "predator", "Predator"),
	("weeds", "weed", "Weed"),
	("incidents", "incident", "Incident"),
	("physiological_disorders", "physiological_disorder", "Physiological Disorder"),
	("traps", "trap", "Trap"),
]

if not _EXECUTE:
	print("[DRY RUN] Set _EXECUTE = True to commit.")
else:
	# --- Ensure Rose Crop Scouted exists and is fully populated --------------
	if frappe.db.exists("Crop Scouted", _CROP_NAME):
		_crop = frappe.get_doc("Crop Scouted", _CROP_NAME)
		print("Found existing Crop Scouted: %s" % _CROP_NAME)
	else:
		_crop = frappe.get_doc({"doctype": "Crop Scouted", "crop_name": _CROP_NAME})
		_crop.insert(ignore_permissions=True)
		print("Created Crop Scouted: %s" % _CROP_NAME)

	for _cf, _lf, _md in _CATEGORY_TABLES:
		_existing = {row.get(_lf) for row in (_crop.get(_cf) or [])}
		_masters = frappe.get_all(_md, pluck="name")
		_added = 0
		for _m in _masters:
			if _m in _existing:
				continue
			_crop.append(_cf, {_lf: _m})
			_added += 1
		print("  %-28s existing=%d  added=%d  total_masters=%d" % (
			_cf, len(_existing), _added, len(_masters),
		))

	_crop.save(ignore_permissions=True)
	_crop_name = _crop.name

	# --- Backfill Scouting Entry rows ----------------------------------------
	_pending = frappe.db.count(
		"Scouting Entry",
		{"crop_scouted": ["is", "not set"]},
	)
	print("\nScouting Entry rows with empty crop_scouted: %d" % _pending)

	if _pending:
		frappe.db.sql(
			"""
			UPDATE `tabScouting Entry`
			SET crop_scouted = %s
			WHERE crop_scouted IS NULL OR crop_scouted = ''
			""",
			(_crop_name,),
		)
	_updated = _pending

	frappe.db.commit()

	print("")
	print("=" * 60)
	print("DONE")
	print("  Crop Scouted    : %s" % _crop_name)
	print("  Entries updated : %d" % _updated)
	print("=" * 60)
