"""
Seed script for Phase 1 of the flexible farm hierarchy.

Does:
  1. Re-syncs Bed doctype (new unit_type + number_of_trees fields, new autoname)
  2. Syncs new Farm Filter child doctype
  3. Re-syncs Crop Scouted (now with farms multi-select)
  4. Creates Section & Block Warehouse Type records
  5. Under Lokitela - KL, creates:
       - 2 Sections (23HA_SECTION, 70HA_SECTION)
       - 2 Blocks (WESA BL 1, WESA BL 2)
       - 3 Rows (as Bed records, unit_type=Row) per block
       - 2 Trees (as Zone records) under Row 1 of Block 1
       - 1 Trap on WESA BL 1
  6. Tags Avocado crop → farms = [Lokitela]

USAGE (bench console)
---------------------
exec(open('/home/ubuntu/stive/code/frappe15/apps/upande_scp/seed_lokitela_hierarchy.py').read())
"""

import frappe
from frappe.modules.import_file import import_file_by_path

_APP_BASE = "/home/ubuntu/stive/code/frappe15/apps/upande_scp/upande_scp/upande_scp/doctype"

# ------------------------------------------------------------------ 1. Schema
print("[1/6] Re-syncing doctype JSON files...")
for _dt in ["bed", "farm_filter", "crop_scouted"]:
	_path = f"{_APP_BASE}/{_dt}/{_dt}.json"
	print(f"  importing {_path}")
	import_file_by_path(_path, force=True, reset_permissions=False)

# Backfill unit_type="Bed" on any existing Bed rows where it's NULL
frappe.db.sql(
	"UPDATE `tabBed` SET unit_type = 'Bed' WHERE unit_type IS NULL OR unit_type = ''"
)

# ------------------------------------------------------------------ 2. Warehouse Types
print("\n[2/6] Ensuring Warehouse Types (Section, Block)...")
for _wt in ["Section", "Block"]:
	if frappe.db.exists("Warehouse Type", _wt):
		print(f"  {_wt} exists")
	else:
		frappe.get_doc({"doctype": "Warehouse Type", "name": _wt}).insert(
			ignore_permissions=True
		)
		print(f"  {_wt} created")

# ------------------------------------------------------------------ 3. Lokitela hierarchy
print("\n[3/6] Building Lokitela hierarchy...")

_COMPANY = frappe.db.get_value("Warehouse", "Lokitela - KL", "company") or "Kaitet Ltd."

# (name, parent, warehouse_type, is_group, warehouse_name)
_WH_PLAN = [
	("23HA_SECTION - KL", "Lokitela - KL",      "Section", 1, "23HA_SECTION"),
	("70HA_SECTION - KL", "Lokitela - KL",      "Section", 1, "70HA_SECTION"),
	("WESA BL 1 - KL",    "23HA_SECTION - KL",  "Block",   0, "WESA BL 1"),
	("WESA BL 2 - KL",    "70HA_SECTION - KL",  "Block",   0, "WESA BL 2"),
]

for _name, _parent, _wh_type, _is_group, _wh_name in _WH_PLAN:
	if frappe.db.exists("Warehouse", _name):
		print(f"  {_name} exists")
		continue
	_doc = frappe.get_doc({
		"doctype": "Warehouse",
		"warehouse_name": _wh_name,
		"parent_warehouse": _parent,
		"warehouse_type": _wh_type,
		"is_group": _is_group,
		"company": _COMPANY,
		"custom_farm": "Lokitela",
	})
	_doc.insert(ignore_permissions=True)
	print(f"  {_doc.name} created")

# ------------------------------------------------------------------ 4. Rows
print("\n[4/6] Creating Rows (Bed records with unit_type=Row)...")
_ROW_PLANS = [
	("WESA BL 1 - KL", ["1", "2", "3"]),
	("WESA BL 2 - KL", ["1", "2", "3"]),
]
for _block, _row_ids in _ROW_PLANS:
	for _rid in _row_ids:
		_name = f"{_block} - Row {_rid}"
		if frappe.db.exists("Bed", _name):
			print(f"  {_name} exists")
			continue
		_doc = frappe.get_doc({
			"doctype": "Bed",
			"greenhouse": _block,
			"bed": _rid,
			"unit_type": "Row",
			"bed_length": 50,
			"number_of_trees": 20,
		})
		_doc.insert(ignore_permissions=True)
		print(f"  {_doc.name} created")

# ------------------------------------------------------------------ 5. Trees (Zones)
print("\n[5/6] Creating Trees as Zone rows under WESA BL 1 Row 1...")
_bed_row_1 = "WESA BL 1 - KL - Row 1"
for _tree_no in ["1", "2"]:
	_zname = f"{_bed_row_1} - Zone {_tree_no}"
	if frappe.db.exists("Zone", _zname):
		print(f"  {_zname} exists")
		continue
	_z = frappe.get_doc({
		"doctype": "Zone",
		"greenhouse": "WESA BL 1 - KL",
		"bed": _bed_row_1,
		"zone": _tree_no,
	})
	_z.insert(ignore_permissions=True)
	print(f"  {_z.name} created")

# ------------------------------------------------------------------ 6. Trap + Avocado farm tag
print("\n[6/6] Creating trap and tagging Avocado...")
_trap_name = "Lokitela - 2001"
if not frappe.db.exists("Trap", _trap_name):
	_trap = frappe.get_doc({
		"doctype": "Trap",
		"farm": "Lokitela",
		"greenhouse": "WESA BL 1 - KL",
		"trap_number": "2001",
		"location": "Outdoor",
		"type": "FCM",
	})
	_trap.insert(ignore_permissions=True)
	print(f"  {_trap.name} created")
else:
	print(f"  {_trap_name} exists")

# Tag Avocado → farms: [Lokitela]
if frappe.db.exists("Crop Scouted", "Avocado"):
	_avocado = frappe.get_doc("Crop Scouted", "Avocado")
	_farm_links = {r.farm for r in (_avocado.get("farms") or [])}
	if "Lokitela" not in _farm_links:
		_avocado.append("farms", {"farm": "Lokitela"})
		_avocado.save(ignore_permissions=True)
		print("  Avocado tagged to Lokitela")
	else:
		print("  Avocado already tagged to Lokitela")

frappe.db.commit()

print("")
print("=" * 60)
print("DONE — Phase 1 schema + Lokitela seed complete.")
print("=" * 60)
