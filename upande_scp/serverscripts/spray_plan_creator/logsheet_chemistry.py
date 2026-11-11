"""Fill the chemistry columns of a Spray Application Logsheet's pesticide rows.

The logsheet is created at tank-mix manufacture with only name, rate and quantity.
The rest (active ingredients, toxicity class, FLO HML category, % a.i, tank water,
total a.i) is master data that lives on the Spray Product, so it is resolved here,
once, instead of being typed by hand.

Field mapping (Spray Application Pesticide <- source)
  active_ingredients <- Spray Product.active_ingredients, "Name 400 g/L + Name 100 g/L"
  toxicity_class     <- Spray Product.toxicity (WHO class I-IV)
  flo_hml            <- Spray Product.fairtrade_hml (Yellow / Orange / Red)
  percent_ai         <- sum over ingredients of concentration as a percentage:
                          g/L  -> % w/v = g/L / 10
                          g/kg -> % w/w = g/kg / 10
                          %    -> as is
                        CFU/OB units are counts, not mass: shown in the ingredient
                        text but left out of the % and the total.
  water_volume       <- Work Order.custom_water_volume (litres of tank water; the
                        same figure for every row of the logsheet)
  total_ai           <- pesticide_quantity (in the item's stock UOM, converted to
                        L or kg) x concentration, grams, summed over mass-based
                        ingredients. 1 % = 10 g per L or kg.

Rules: fill blanks only (a typed value is never replaced); never raise because master
data is missing - the cell is simply left blank.
"""

import frappe
from frappe.utils import flt

CHILD = "Spray Application Pesticide"
FIELDS = ("active_ingredients", "toxicity_class", "flo_hml", "percent_ai", "water_volume", "total_ai")

# stock UOM -> multiplier to litres/kilograms (the unit the g/L, g/kg figures are per)
_UOM_TO_BASE = {
	"litre": 1.0, "liter": 1.0, "l": 1.0, "ltr": 1.0,
	"kg": 1.0, "kilogram": 1.0, "kgs": 1.0,
	"ml": 0.001, "millilitre": 0.001, "milliliter": 0.001,
	"g": 0.001, "gram": 0.001, "grams": 0.001,
}
_MASS_UNITS = ("g/L", "g/kg", "%")


def _blank(v):
	return v is None or v == "" or (isinstance(v, (int, float)) and not v)


def _fmt(n):
	return ("%g" % round(flt(n), 4))


def chemistry_for_product(product, quantity=None, stock_uom=None):
	"""Pure-ish core. `product` is a Spray Product doc/dict (or None); returns a dict
	of the values it can determine. Missing data -> key absent."""
	if not product:
		return {}
	get = product.get if hasattr(product, "get") else (lambda k: getattr(product, k, None))
	out = {}
	parts, pct, grams_per_unit, any_mass = [], 0.0, 0.0, False
	# One entry per ingredient (case-insensitive): the master can hold a bare-name row
	# beside the row that carries the concentration; the row with a figure wins.
	merged = {}
	for ai in (get("active_ingredients") or []):
		g = ai.get if hasattr(ai, "get") else (lambda k, _a=ai: getattr(_a, k, None))
		name = (g("active_ingredient") or g("ingredient") or "").strip()
		if not name:
			continue
		entry = (name, flt(g("concentration")), (g("concentration_unit") or "").strip())
		key = name.lower()
		if key not in merged or (entry[1] and not merged[key][1]):
			merged[key] = entry
	for name, conc, unit in merged.values():
		parts.append(f"{name} {_fmt(conc)} {unit}".strip() if conc else name)
		if conc and unit in _MASS_UNITS:
			any_mass = True
			per_unit = conc * 10.0 if unit == "%" else conc  # g per L/kg
			grams_per_unit += per_unit
			pct += conc if unit == "%" else conc / 10.0
	if parts:
		out["active_ingredients"] = " + ".join(parts)[:140]
	if get("toxicity"):
		out["toxicity_class"] = get("toxicity")
	if get("fairtrade_hml"):
		out["flo_hml"] = get("fairtrade_hml")
	if any_mass:
		out["percent_ai"] = round(pct, 4)
		factor = _UOM_TO_BASE.get((stock_uom or "").strip().lower())
		if factor is not None and flt(quantity) > 0:
			out["total_ai"] = round(flt(quantity) * factor * grams_per_unit, 3)
	return out


def _resolve_item(name, wo_items):
	"""The Item behind a row's pesticide_name (item_name or item_code)."""
	if not name:
		return None
	if name in wo_items:
		return wo_items[name]
	if frappe.db.exists("Item", name):
		return name
	rows = frappe.get_all("Item", filters={"item_name": name}, pluck="name", limit=5)
	for r in rows:
		if frappe.db.exists("Spray Product", {"item": r}):
			return r
	return rows[0] if rows else None


def _wo_context(work_order):
	if not work_order:
		return 0.0, {}
	wv = flt(frappe.db.get_value("Work Order", work_order, "custom_water_volume"))
	items = {}
	for r in frappe.get_all("Work Order Item", filters={"parent": work_order},
	                        fields=["item_code", "item_name"]):
		items[r.item_name or r.item_code] = r.item_code
	return wv, items


def _row_values(name, quantity, wo_items, water, cache):
	item = _resolve_item(name, wo_items)
	if not item:
		vals = {}
	else:
		if item not in cache:
			from upande_scp.serverscripts.common.crop_protection import get_spray_product
			cache[item] = (get_spray_product(item), frappe.db.get_value("Item", item, "stock_uom"))
		product, uom = cache[item]
		vals = chemistry_for_product(product, quantity, uom)
	if water:
		vals["water_volume"] = water
	return vals


def fill_pesticide_rows(sal):
	"""Fill blank chemistry cells on an in-memory logsheet (validate/insert path).
	Returns the number of cells filled. Never raises for missing master data."""
	try:
		water, wo_items = _wo_context(sal.get("work_order"))
		cache, n = {}, 0
		for row in sal.get("pesticides") or []:
			vals = _row_values(row.pesticide_name, row.pesticide_quantity, wo_items, water, cache)
			for f, v in vals.items():
				if _blank(row.get(f)):
					row.set(f, v)
					n += 1
		return n
	except Exception:
		frappe.log_error(frappe.get_traceback(), "fill_pesticide_rows")
		return 0


def validate_logsheet(doc, method=None):
	fill_pesticide_rows(doc)


@frappe.whitelist()
def backfill_logsheet_chemistry(from_date=None, dry_run=1):
	"""Fill blank chemistry cells on existing logsheet rows (submitted ones too, via
	direct writes). Fill-blanks-only. dry_run=1 only counts. Returns counts per field."""
	frappe.only_for(("System Manager", "Administrator"))
	dry = frappe.utils.cint(dry_run) != 0
	filters = {"docstatus": ["<", 2]}
	if from_date:
		filters["date"] = [">=", from_date]
	counts = {f: 0 for f in FIELDS}
	counts_unresolved = 0
	rows_seen = rows_touched = 0
	cache = {}
	for sal in frappe.get_all("Spray Application Logsheet", filters=filters,
	                          fields=["name", "work_order"], order_by="date desc"):
		water, wo_items = _wo_context(sal.work_order)
		for r in frappe.get_all(CHILD, filters={"parent": sal.name, "parenttype": "Spray Application Logsheet"},
		                        fields=["name", "pesticide_name", "pesticide_quantity", *FIELDS]):
			rows_seen += 1
			vals = _row_values(r.pesticide_name, r.pesticide_quantity, wo_items, water, cache)
			if not vals:
				counts_unresolved += 1
			upd = {f: v for f, v in vals.items() if _blank(r.get(f))}
			if not upd:
				continue
			rows_touched += 1
			for f in upd:
				counts[f] += 1
			if not dry:
				frappe.db.set_value(CHILD, r.name, upd, update_modified=False)
	if not dry:
		frappe.db.commit()
	res = {"dry_run": dry, "rows_seen": rows_seen, "rows_touched": rows_touched,
	       "rows_with_no_master_data": counts_unresolved, "cells_filled": counts}
	print(res)
	return res
