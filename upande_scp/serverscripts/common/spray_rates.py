"""Spray Product rates: stock UOM per an amount of Water or Area.

A rate is a dose in the product's stock UOM (Litre, Kg, ...) per ``per_qty`` of
``per_uom``, where the determinant (``basis``) says what the denominator measures:

  * Water      - a Volume UOM (Litre, Millilitre, Gallon ...), measured against the
                 spray water volume the planner typed
  * Hectarage  - an Area UOM (Hectare, Acre, Square Meter ...), measured against the
                 area sprayed. Shown to users as "Area"; the stored value keeps its name.

Quantity: ``qty = rate * measure / per_base`` where the measure is in Litre or
Square Meter and ``per_base = per_qty * (base units in one per_uom)``. ``per_base``
comes from ERPNext ``UOM Conversion Factor`` only; a UOM that does not convert to the
base is refused. A row with no ``per_uom`` reads as the legacy unit (per 1000 Litre,
per 1 Hectare = 10,000 m2), and the ``default_*_rate_limit`` pair stays the per-1000 L
Water fallback, so every existing number gives the same quantity.

Rows live in the Spray Product's ``crop_rates`` table and can be scoped to a crop.
"""

import frappe
from frappe.utils import flt

WATER = "Water"
HECTARAGE = "Hectarage"
BASES = (WATER, HECTARAGE)
BASE_UOM = {WATER: "Litre", HECTARAGE: "Square Meter"}
UOM_CATEGORY = {WATER: "Volume", HECTARAGE: "Area"}
LEGACY_UNIT = {WATER: (1000.0, "Litre"), HECTARAGE: (1.0, "Hectare")}
BASIS_NOUN = {WATER: "of water", HECTARAGE: "of area"}
# kept for callers that still name the legacy unit sizes
WATER_UNIT_L = 1000.0
HECTARAGE_UNIT_M2 = 10000.0


def _norm_basis(basis):
	return HECTARAGE if basis == HECTARAGE else WATER


def uom_to_base(uom: str, basis: str) -> float:
	"""How many base units (Litre for Water, Square Meter for Hectarage) one ``uom`` is.

	Read from ``UOM Conversion Factor`` in either direction. Throws when the UOM is not
	of the basis's category or has no conversion to the base.
	"""
	basis = _norm_basis(basis)
	base = BASE_UOM[basis]
	if uom == base:
		return 1.0
	category = frappe.db.get_value("UOM", uom, "category")
	if category != UOM_CATEGORY[basis]:
		frappe.throw(
			f"{uom} is not a {UOM_CATEGORY[basis]} unit, so it cannot be used for a "
			f"{'Water' if basis == WATER else 'Area'} rate.",
			frappe.ValidationError,
		)
	# value = how many `to_uom` in one `from_uom`
	v = frappe.db.get_value("UOM Conversion Factor", {"from_uom": base, "to_uom": uom}, "value")
	if flt(v):
		return round(1.0 / flt(v), 9)
	v = frappe.db.get_value("UOM Conversion Factor", {"from_uom": uom, "to_uom": base}, "value")
	if flt(v):
		return round(flt(v), 9)
	frappe.throw(
		f"No UOM Conversion Factor between {uom} and {base}. Add one under "
		"Stock > UOM Conversion Factor before using it for a rate.",
		frappe.ValidationError,
	)


def per_unit(basis, per_qty=None, per_uom=None):
	"""(per_qty, per_uom, per_base) for a row, falling back to the legacy unit when blank."""
	basis = _norm_basis(basis)
	legacy_qty, legacy_uom = LEGACY_UNIT[basis]
	uom = per_uom or legacy_uom
	qty = flt(per_qty) or (legacy_qty if not per_uom else 1.0)
	return qty, uom, qty * uom_to_base(uom, basis)


def _n(x):
	return f"{flt(x):g}"


def rate_line(name, stock_uom, basis, lower, upper, per_qty, per_uom):
	""""Amisil: 0.3-1 Litre per 1000 Litre of water" (the product name is optional)."""
	lo, up = flt(lower), flt(upper)
	span = f"{_n(lo)}\u2013{_n(up)}" if lo and up and lo != up else _n(lo or up)
	denom = f"{_n(per_qty)} {per_uom}" if flt(per_qty) != 1 else f"{per_uom}"
	text = f"{span} {stock_uom or ''} per {denom} {BASIS_NOUN[_norm_basis(basis)]}".replace("  ", " ")
	return f"{name}: {text}" if name else text


def rates_for(item_code: str, crop: str | None) -> list[dict]:
	"""Rate rows for a product, most specific first.

	Order: rows for ``crop``, then rows with no crop, then the legacy per-1000 L
	default as a Water row. Rows for other crops are never returned. Each row carries
	its unit (``per_qty``, ``per_uom``) and ``per_base``, the denominator in Litre or
	Square Meter, so a client multiplies without needing the conversion table.
	"""
	if not item_code or not frappe.db.exists("Spray Product", item_code):
		return []
	sp = frappe.db.get_value("Spray Product", item_code, ["stock_uom", "item"], as_dict=True)
	stock_uom = (sp and sp.stock_uom) or (sp and sp.item and frappe.db.get_value("Item", sp.item, "stock_uom")) or ""
	rows = frappe.db.get_all(
		"Spray Product Crop Rate",
		filters={"parent": item_code, "parenttype": "Spray Product"},
		fields=["crop", "basis", "lower_rate_limit", "upper_rate_limit", "per_qty", "per_uom"],
		order_by="idx asc",
	)

	def build(basis, lower, upper, crop_, source, per_qty=None, per_uom=None):
		basis = _norm_basis(basis)
		pq, pu, pb = per_unit(basis, per_qty, per_uom)
		return {
			"basis": basis, "lower": lower, "upper": upper, "crop": crop_ or None, "source": source,
			"per_qty": pq, "per_uom": pu, "per_base": pb, "stock_uom": stock_uom,
			"line": rate_line(None, stock_uom, basis, lower, upper, pq, pu),
		}

	specific, general = [], []
	for r in rows:
		lower, upper = flt(r.lower_rate_limit), flt(r.upper_rate_limit)
		if not (lower or upper):
			continue
		out = build(r.basis, lower, upper, r.crop, "crop", r.per_qty, r.per_uom)
		if r.crop:
			if crop and r.crop == crop:
				specific.append(out)
		else:
			general.append(out)
	result = specific + general
	d = frappe.db.get_value(
		"Spray Product", item_code,
		["default_lower_rate_limit", "default_upper_rate_limit"], as_dict=True,
	)
	if d and (flt(d.default_lower_rate_limit) or flt(d.default_upper_rate_limit)):
		result.append(build(WATER, flt(d.default_lower_rate_limit), flt(d.default_upper_rate_limit), None, "default"))
	return result


def pick_row(rows: list[dict], prefer_area: bool = False) -> dict | None:
	"""The row a plan measures a product by.

	Open-field block plans (``prefer_area``) take an Area row when the product has one;
	greenhouse plans are planned through the water volume, so they take a Water row. Either
	falls back to the first row. Rows arrive most specific first; the client applies the
	same rule.
	"""
	want = HECTARAGE if prefer_area else WATER
	for r in rows:
		if r["basis"] == want:
			return r
	return rows[0] if rows else None


def needs_water(item_codes, crop: str | None, prefer_area: bool = False) -> bool:
	"""True when any product in the mix is measured against water (or has no rate rows,
	which read as a per-1000 L Water rate). An all-Area mix needs no water volume."""
	for code in item_codes:
		row = pick_row(rates_for(code, crop), prefer_area)
		if row is None or row["basis"] == WATER:
			return True
	return False


def water_bounds(item_code: str, crop: str | None = None):
	"""(lower, upper) per 1000 L for the first Water row, or (None, None).

	A row set per another amount (e.g. per 100 L) is rescaled to per 1000 L.
	"""
	for r in rates_for(item_code, crop):
		if r["basis"] == WATER:
			k = WATER_UNIT_L / r["per_base"]
			return (r["lower"] * k, r["upper"] * k)
	return (None, None)


def quantity_for(
	rate: float, basis: str, area_m2: float | None = None, water_l: float | None = None,
	per_base: float | None = None,
) -> float:
	"""Absolute quantity: rate * measure / per_base (default: the legacy 1000 L / 10,000 m2)."""
	if _norm_basis(basis) == HECTARAGE:
		if not area_m2:
			frappe.throw(
				"An Area rate needs the area (m²) of the application, which is missing.",
				frappe.ValidationError,
			)
		return flt(rate) * flt(area_m2) / (per_base or HECTARAGE_UNIT_M2)
	if not water_l:
		frappe.throw(
			"A Water rate needs the spray water volume (L) of the application, which is missing.",
			frappe.ValidationError,
		)
	return flt(rate) * flt(water_l) / (per_base or WATER_UNIT_L)


def rate_from_quantity(
	qty: float, row: dict, area_m2: float | None = None, water_l: float | None = None
) -> float | None:
	"""The rate (in the row's unit) an absolute quantity amounts to; None when the measure is missing."""
	measure = area_m2 if row["basis"] == HECTARAGE else water_l
	if not flt(measure):
		return None
	return flt(qty) * row["per_base"] / flt(measure)


def rate_status(
	item_code: str, crop: str | None, qty: float,
	area_m2: float | None = None, water_l: float | None = None, prefer_area: bool = False,
) -> str:
	"""'ok' | 'below' | 'above' for a stored quantity against the product's range.

	Uses the same row the plan picked (``pick_row``) and the same conversion as the
	client, so a plan the panel shows in range is in range here.
	"""
	row = pick_row(rates_for(item_code, crop), prefer_area)
	if not row:
		return "ok"
	rate = rate_from_quantity(qty, row, area_m2, water_l)
	if rate is None:
		return "ok"
	rate = round(rate, 6)
	if row["lower"] and rate < row["lower"]:
		return "below"
	if row["upper"] and rate > row["upper"]:
		return "above"
	return "ok"


def rate_uoms() -> dict:
	"""{basis: [UOM names]} a rate's denominator may use: enabled UOMs of the basis's category
	that convert to its base (Litre / Square Meter), the base first."""
	out = {}
	for basis in BASES:
		base = BASE_UOM[basis]
		names = {base}
		for a, b in frappe.db.sql(
			"SELECT from_uom, to_uom FROM `tabUOM Conversion Factor` WHERE from_uom=%s OR to_uom=%s",
			(base, base),
		):
			names.update((a, b))
		ok = frappe.get_all(
			"UOM", filters={"name": ("in", list(names)), "enabled": 1, "category": UOM_CATEGORY[basis]}, pluck="name"
		)
		out[basis] = sorted(ok, key=lambda n: (n != base, n.lower()))
	return out


@frappe.whitelist()
def get_rate_uoms() -> dict:
	"""For the rate editors: the UOMs each determinant offers, from ERPNext's conversions."""
	return rate_uoms()


@frappe.whitelist()
def get_spray_product_rates(item_codes, crop=None) -> dict:
	"""{item_code: rates_for(item_code, crop)} for a JSON string or a list of codes."""
	if isinstance(item_codes, str):
		item_codes = frappe.parse_json(item_codes) if item_codes.strip().startswith("[") else [item_codes]
	if not frappe.has_permission("Spray Product", "read"):
		frappe.throw("Not permitted", frappe.PermissionError)
	return {code: rates_for(code, crop or None) for code in (item_codes or []) if code}
