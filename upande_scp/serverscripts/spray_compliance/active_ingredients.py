"""Active ingredients of the products in a tank mix, and how much of each the plan uses.

Read live from the Spray Product's `active_ingredients` table (each row links an
`Active Ingredient MoA` that carries the IRAC/FRAC group). The amount is the row's
required quantity (as the floor plan has it, after water-volume scaling, in the row's
UoM) times the recorded concentration. Nothing is guessed: no concentration, no unit, or
a quantity whose dimension does not fit the concentration's gives a status instead of a
number.

    concentration  qty is   amount of active ingredient
    g/L            volume   litres x c                      -> g
    g/kg           mass     kg x c                          -> g
    %  (w/v)       volume   litres x 10 x c                 -> g   (c g per 100 mL = 10c g/L)
    %  (w/w)       mass     kg x 10 x c                     -> g   (c g per 100 g  = 10c g/kg)
    CFU/g          mass     g  x c                          -> CFU
    CFU/mL         volume   mL x c                          -> CFU
    OB/mL          volume   mL x c                          -> OB

`%` has no w/v or w/w flag on the record: it follows the quantity's dimension (a litre
quantity is w/v, a kilo quantity w/w).
"""

from __future__ import annotations

# litres / kilograms per 1 of the unit
_VOLUME = {"l": 1.0, "ltr": 1.0, "litre": 1.0, "liter": 1.0, "ml": 0.001, "millilitre": 0.001,
           "milliliter": 0.001}
_MASS = {"kg": 1.0, "kilogram": 1.0, "g": 0.001, "gm": 0.001, "gram": 0.001, "mg": 1e-6, "milligram": 1e-6}


def dimension(uom):
	"""("volume"|"mass", base units per 1 of `uom`) or None for an unknown unit (Bottle, Box...)."""
	k = (uom or "").strip().lower().rstrip(".")
	if k.endswith("s") and k[:-1] in _VOLUME | _MASS:
		k = k[:-1]
	if k in _VOLUME:
		return "volume", _VOLUME[k]
	if k in _MASS:
		return "mass", _MASS[k]
	return None


def ai_amount(qty, uom, concentration, unit, uom_factor=1.0) -> dict:
	"""`{status, amount, amount_unit}`. status: ok | no_concentration | no_quantity | unit_mismatch.
	`uom_factor` multiplies `qty` first (qty in a custom UoM -> `uom`, e.g. bottles -> litres)."""
	c = float(concentration or 0)
	if c <= 0 or not unit:
		return {"status": "no_concentration", "amount": None, "amount_unit": None}
	q = float(qty or 0) * float(uom_factor or 1)
	dim = dimension(uom)
	if q <= 0 or not dim:
		return {"status": "no_quantity" if q <= 0 else "unit_mismatch", "amount": None, "amount_unit": None}
	kind, per = dim
	base = q * per  # litres or kilograms
	out = None
	if unit == "g/L" and kind == "volume":
		out = base * c, "g"
	elif unit == "g/kg" and kind == "mass":
		out = base * c, "g"
	elif unit == "%":
		out = base * 10 * c, "g"
	elif unit == "CFU/g" and kind == "mass":
		out = base * 1000 * c, "CFU"
	elif unit == "CFU/mL" and kind == "volume":
		out = base * 1000 * c, "CFU"
	elif unit == "OB/mL" and kind == "volume":
		out = base * 1000 * c, "OB"
	if out is None:
		return {"status": "unit_mismatch", "amount": None, "amount_unit": None}
	return {"status": "ok", "amount": out[0], "amount_unit": out[1]}


def _label(c, unit):
	if not c or not unit:
		return None
	return f"{c:g} {unit}"


def load_ingredients(items) -> dict:
	"""{item_code: [ingredient rows]} read live from the Spray Products."""
	import frappe
	items = sorted({i for i in items if i})
	if not items:
		return {}
	out: dict = {}
	for r in frappe.db.sql(
			"""select ai.parent item, ai.ingredient, ai.active_ingredient, ai.concentration, ai.concentration_unit,
			          m.irac_code, m.frac_code
			   from `tabActive Ingredient` ai
			   left join `tabActive Ingredient MoA` m on m.name = ai.active_ingredient
			   where ai.parenttype = 'Spray Product' and ai.parentfield = 'active_ingredients'
			     and ai.parent in %(p)s order by ai.parent, ai.idx""", {"p": tuple(items)}, as_dict=True):
		codes = ([f"IRAC {r.irac_code}"] if r.irac_code else []) + ([f"FRAC {r.frac_code}"] if r.frac_code else [])
		c = float(r.concentration or 0)
		out.setdefault(r.item, []).append({
			"name": r.ingredient or r.active_ingredient, "active_ingredient": r.active_ingredient,
			"codes": codes, "concentration": c or None, "concentration_unit": r.concentration_unit or None,
			"concentration_label": _label(c, r.concentration_unit)})
	return out


def _uom_factor(item, uom):
	"""Quantity in `uom` -> the unit `dimension` understands: (uom to read, factor). An unknown
	UoM is converted through the Item's own UOM Conversion Detail into its stock UoM."""
	import frappe
	if dimension(uom):
		return uom, 1.0
	stock = frappe.db.get_value("Item", item, "stock_uom")
	f = frappe.db.get_value("UOM Conversion Detail", {"parent": item, "uom": uom}, "conversion_factor")
	return (stock, float(f)) if stock and f else (uom, 1.0)


def mix_ingredients(rows, area=None) -> dict:
	"""rows = [{item_code, qty, uom}] -> {item_code: {ingredients: [...]}} with the amount each
	ingredient contributes to this plan and per hectare when `area` (ha) is known."""
	area = float(area or 0)
	by_item = load_ingredients([r.get("item_code") for r in rows])
	out = {}
	for r in rows:
		item = r.get("item_code")
		if not item:
			continue
		uom, factor = _uom_factor(item, r.get("uom"))
		ingredients = []
		for i in by_item.get(item, []):
			a = ai_amount(r.get("qty"), uom, i["concentration"], i["concentration_unit"], factor)
			amt = a["amount"]
			ingredients.append({**i, **a, "per_ha": (amt / area) if amt is not None and area > 0 else None})
		out[item] = {"ingredients": ingredients}
	return out
