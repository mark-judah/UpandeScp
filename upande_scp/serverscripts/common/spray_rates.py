"""Spray Product rates, by determinant (what the rate is measured against).

A rate is a dose per a unit of *something*:

  * Water      - per 1000 L of spray water  (qty = rate * water_l / 1000)
  * Hectarage  - per 10,000 m2 of area      (qty = rate * area_m2 / 10000)

A product can carry both, and rows can be scoped to a crop. Rows live in the
Spray Product's ``crop_rates`` table; the legacy ``default_lower_rate_limit`` /
``default_upper_rate_limit`` pair remains the per-1000 L Water fallback so no
existing data needs migrating.
"""

import frappe
from frappe.utils import flt

WATER = "Water"
HECTARAGE = "Hectarage"
BASES = (WATER, HECTARAGE)
WATER_UNIT_L = 1000.0
HECTARAGE_UNIT_M2 = 10000.0
UNIT_LABEL = {WATER: "per 1000 L", HECTARAGE: "per 10,000 m²"}


def _norm_basis(basis):
	return HECTARAGE if basis == HECTARAGE else WATER


def rates_for(item_code: str, crop: str | None) -> list[dict]:
	"""Rate rows for a product, most specific first.

	Order: rows for ``crop``, then rows with no crop, then the legacy per-1000 L
	default as a Water row. Rows for other crops are never returned.
	"""
	if not item_code or not frappe.db.exists("Spray Product", item_code):
		return []
	rows = frappe.db.get_all(
		"Spray Product Crop Rate",
		filters={"parent": item_code, "parenttype": "Spray Product"},
		fields=["crop", "basis", "lower_rate_limit", "upper_rate_limit"],
		order_by="idx asc",
	)
	specific, general = [], []
	for r in rows:
		lower, upper = flt(r.lower_rate_limit), flt(r.upper_rate_limit)
		if not (lower or upper):
			continue
		out = {
			"basis": _norm_basis(r.basis),
			"lower": lower,
			"upper": upper,
			"crop": r.crop or None,
			"source": "crop",
		}
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
		result.append({
			"basis": WATER,
			"lower": flt(d.default_lower_rate_limit),
			"upper": flt(d.default_upper_rate_limit),
			"crop": None,
			"source": "default",
		})
	return result


def water_bounds(item_code: str, crop: str | None = None):
	"""(lower, upper) per 1000 L for the first Water row, or (None, None)."""
	for r in rates_for(item_code, crop):
		if r["basis"] == WATER:
			return (r["lower"], r["upper"])
	return (None, None)


def quantity_for(
	rate: float, basis: str, area_m2: float | None = None, water_l: float | None = None
) -> float:
	"""Absolute quantity for a rate: Water -> rate*water_l/1000, Hectarage -> rate*area_m2/10000."""
	if _norm_basis(basis) == HECTARAGE:
		if not area_m2:
			frappe.throw(
				"A Hectarage rate needs the area (m²) of the application, which is missing.",
				frappe.ValidationError,
			)
		return flt(rate) * flt(area_m2) / HECTARAGE_UNIT_M2
	if not water_l:
		frappe.throw(
			"A Water rate needs the spray water volume (L) of the application, which is missing.",
			frappe.ValidationError,
		)
	return flt(rate) * flt(water_l) / WATER_UNIT_L


@frappe.whitelist()
def get_spray_product_rates(item_codes, crop=None) -> dict:
	"""{item_code: rates_for(item_code, crop)} for a JSON string or a list of codes."""
	if isinstance(item_codes, str):
		item_codes = frappe.parse_json(item_codes) if item_codes.strip().startswith("[") else [item_codes]
	if not frappe.has_permission("Spray Product", "read"):
		frappe.throw("Not permitted", frappe.PermissionError)
	return {code: rates_for(code, crop or None) for code in (item_codes or []) if code}
