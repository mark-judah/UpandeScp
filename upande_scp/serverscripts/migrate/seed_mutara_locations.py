"""Seed Mutara's scouting locations: crops, warehouse tree, demo rows and trees.

    bench --site mutara.local execute \
        upande_scp.serverscripts.migrate.seed_mutara_locations.run

    bench --site mutara.local execute \
        upande_scp.serverscripts.migrate.seed_mutara_locations.run --kwargs "{'dry_run': True}"

Idempotent: everything is looked up before it is created, existing records are
never overwritten (crops only gain missing farm / production_items rows), so a
second run creates nothing. Prints what it creates (or would create).

Site seed data. The Phase / Section names are DEMO placeholders until Mutara
supplies the real ones.
"""

import frappe

FARM = "Mutara"
COMPANY = "Mutara"

#: Demo placeholders for the avocado levels above the blocks.
AVOCADO_PHASE = "Phase 1"
AVOCADO_SECTION = "Section A"

#: Production Unit unit_type -> how it is mirrored.
AVOCADO_UNIT_TYPE = "Orchard Block"
PIVOT_UNIT_TYPE = "Pivot"
PIVOT_BLOCK_UNIT_TYPE = "Pivot Block"

#: Production Crop Cycle item -> Crop Scouted (the item -> crop link is data).
CROP_ITEMS = {
	"Avocado": ["Hass Avocado", "Fuerte Avocado"],
	"Potato": ["Potatoes"],
	"Onion": ["Onion"],
	"Cabbage": ["Cabbage"],
	"Passion Fruit": ["Passion Fruit"],
	"Corn": ["Maize"],
}

#: Items created when missing (item code -> stock UOM), so a crop can be linked
#: before the first production cycle uses it. Corn (maize) is planted in a pivot
#: block like the other vegetables; no cycle exists for it yet.
CREATE_ITEMS = {"Maize": "Kg"}

#: Farm Types the Mutara farm needs for blocks, rows and trees.
FARM_TYPES = ["Has Phases", "Has Blocks", "Has Rows", "Has Orchard Trees"]

WAREHOUSE_TYPES = ["Phase", "Pivot", "Section", "Block", "Farm"]

AVOCADO_ROWS = 5
TREES_PER_ROW = 8
VEG_ROWS = 4


class _Log:
	def __init__(self, dry_run):
		self.dry_run = dry_run
		self.created = {}

	def made(self, kind, name):
		self.created[kind] = self.created.get(kind, 0) + 1
		print(("would create " if self.dry_run else "created ") + f"{kind}: {name}")


def run(dry_run=False):
	log = _Log(dry_run)
	_warehouse_types(log)
	_farm_types(log)
	_crops(log)
	farm_wh = _farm_warehouse(log)
	_avocado_tree(log, farm_wh)
	_veg_tree(log, farm_wh)
	if not dry_run:
		frappe.db.commit()
	print("summary:", log.created or "nothing to create")
	return log.created


def _insert(log, doc, kind, name):
	log.made(kind, name)
	if log.dry_run:
		return name
	d = frappe.get_doc(doc)
	d.insert(ignore_permissions=True)
	return d.name


def _warehouse_types(log):
	for t in WAREHOUSE_TYPES:
		if not frappe.db.exists("Warehouse Type", t):
			_insert(log, {"doctype": "Warehouse Type", "name": t}, "Warehouse Type", t)


def _farm_types(log):
	for t in FARM_TYPES:
		if not frappe.db.exists("Farm Type", t):
			_insert(log, {"doctype": "Farm Type", "farm_type_name": t}, "Farm Type", t)
	if not frappe.db.exists("Farm", FARM):
		print(f"Farm {FARM} missing; nothing more can be seeded")
		raise SystemExit(1)
	have = set(
		frappe.get_all(
			"Farm Type Item", filters={"parenttype": "Farm", "parent": FARM}, pluck="farm_type"
		)
	)
	missing = [t for t in FARM_TYPES if t not in have]
	if missing:
		for t in missing:
			log.made("Farm Type on Farm", t)
		if not log.dry_run:
			farm = frappe.get_doc("Farm", FARM)
			for t in missing:
				farm.append("farm_type", {"farm_type": t})
			farm.save(ignore_permissions=True)


def _cycle_items():
	if "upande_production" not in frappe.get_installed_apps():
		return {}
	return {
		r.item: r.crop
		for r in frappe.db.sql(
			"select distinct item, crop from `tabProduction Crop Cycle` where item is not null",
			as_dict=True,
		)
	}


def _ensure_items(log):
	for item, uom in CREATE_ITEMS.items():
		if frappe.db.exists("Item", item):
			continue
		_insert(
			log,
			{
				"doctype": "Item",
				"item_code": item,
				"item_name": item,
				"item_group": "Products",
				"stock_uom": uom,
				"is_stock_item": 1,
			},
			"Item",
			item,
		)


def crop_item_map(cycle_items=()):
	"""``{crop: [items]}``: CROP_ITEMS plus the variety items of production cycles.

	Cycles carry the variety item (``Potatoes - Shangi``), the crop lists the base
	item (``Potatoes``), so every cycle item named ``<base> - <variety>`` joins its
	base item's crop. Without this a pivot block never resolves to its crop.
	"""
	out = {crop: list(items) for crop, items in CROP_ITEMS.items()}
	for crop, items in out.items():
		for base in list(items):
			for item in sorted(cycle_items):
				if item.startswith(base + " - ") and item not in items:
					items.append(item)
	return out


def _crops(log):
	_ensure_items(log)
	crop_items = crop_item_map(_cycle_items())
	mapped = {i for items in crop_items.values() for i in items}
	for item in sorted(mapped):
		if not frappe.db.exists("Item", item):
			print(f"WARNING: item {item!r} does not exist; skipped")
	unmapped = sorted(i for i in _cycle_items() if i not in mapped)
	print("items in production cycles mapped to no crop:", unmapped or "none")

	for crop, items in crop_items.items():
		items = [i for i in items if frappe.db.exists("Item", i)]
		if not frappe.db.exists("Crop Scouted", crop):
			log.made("Crop Scouted", crop)
			if log.dry_run:
				continue
			doc = frappe.get_doc({"doctype": "Crop Scouted", "crop_name": crop})
		else:
			doc = frappe.get_doc("Crop Scouted", crop)
		changed = doc.is_new()
		if FARM not in [r.farm for r in doc.get("farms") or []]:
			doc.append("farms", {"farm": FARM})
			log.made("Crop farm tag", f"{crop} -> {FARM}")
			changed = True
		have = {r.item for r in doc.get("production_items") or []}
		for item in items:
			if item not in have:
				doc.append("production_items", {"item": item})
				log.made("Crop production item", f"{crop} <- {item}")
				changed = True
		if changed and not log.dry_run:
			doc.save(ignore_permissions=True)


def _warehouse(log, name, wtype, parent, is_group, crop=None, unit=None):
	"""Find or create a warehouse; returns its full name (with company abbr)."""
	abbr = frappe.get_cached_value("Company", COMPANY, "abbr")
	full = f"{name} - {abbr}"
	if frappe.db.exists("Warehouse", full):
		return full
	return _insert(
		log,
		{
			"doctype": "Warehouse",
			"warehouse_name": name,
			"company": COMPANY,
			"warehouse_type": wtype,
			"parent_warehouse": parent,
			"is_group": 1 if is_group else 0,
			"custom_farm": FARM,
			"custom_crop": crop,
			"custom_production_unit": unit,
		},
		f"Warehouse ({wtype})",
		full,
	)


def _farm_warehouse(log):
	found = frappe.db.get_value(
		"Warehouse", {"warehouse_type": "Farm", "custom_farm": FARM}, "name"
	)
	if found:
		return found
	return _warehouse(log, FARM, "Farm", None, True)


def _units(unit_type):
	return frappe.get_all(
		"Production Unit",
		filters={"unit_type": unit_type},
		fields=["name", "parent_production_unit"],
		order_by="name",
	)


def _avocado_tree(log, farm_wh):
	phase = _warehouse(log, AVOCADO_PHASE, "Phase", farm_wh, True, crop="Avocado")
	section = _warehouse(log, AVOCADO_SECTION, "Section", phase, True)
	for u in _units(AVOCADO_UNIT_TYPE):
		block = _warehouse(log, u.name, "Block", section, False, unit=u.name)
		_ensure_rows(log, block, AVOCADO_ROWS, TREES_PER_ROW)


def _veg_tree(log, farm_wh):
	pivots = {}
	for p in _units(PIVOT_UNIT_TYPE):
		pivots[p.name] = _warehouse(log, p.name, "Pivot", farm_wh, True)
	for u in _units(PIVOT_BLOCK_UNIT_TYPE):
		parent = pivots.get(u.parent_production_unit)
		if not parent:
			print(f"WARNING: {u.name} has no Pivot parent; skipped")
			continue
		block = _warehouse(log, u.name, "Block", parent, False, unit=u.name)
		_ensure_rows(log, block, VEG_ROWS, 0)


def _ensure_rows(log, block, rows, trees):
	"""Rows are Bed records with unit_type Row (kaitet convention); trees hang
	off a row: '<block> - Row n' and '<block> - Row n - Tree m'."""
	exists_wh = frappe.db.exists("Warehouse", block)
	for n in range(1, rows + 1):
		row = f"{block} - Row {n}"
		if not frappe.db.exists("Bed", row):
			if log.dry_run or not exists_wh:
				log.made("Bed (Row)", row)
			else:
				log.made("Bed (Row)", row)
				frappe.get_doc(
					{"doctype": "Bed", "greenhouse": block, "unit_type": "Row", "bed": n}
				).insert(ignore_permissions=True)
		for t in range(1, trees + 1):
			tree = f"{row} - Tree {t}"
			if frappe.db.exists("Orchard Tree", tree):
				continue
			log.made("Orchard Tree", tree)
			if log.dry_run:
				continue
			frappe.get_doc(
				{"doctype": "Orchard Tree", "row": row, "tree": t, "tree_number": str(t)}
			).insert(ignore_permissions=True)
