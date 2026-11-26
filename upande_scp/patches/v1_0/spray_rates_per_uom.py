"""Spray rates per unit: product types as a list, and a unit on every rate row.

* Seeds ``Spray Product Type`` (the five old Select options plus any other value a
  product already carries), so ``Spray Product.type`` is a valid Link everywhere.
* Gives every ``Spray Product Crop Rate`` row its unit, with no change to the numbers:
  Water -> per 1000 Litre, Hectarage -> per 1 Hectare (10,000 m2). Rows that already
  have a unit are left alone. The legacy ``default_*_rate_limit`` pair is not touched; it
  stays the per-1000 Litre Water fallback.
* Fills ``Spray Product.stock_uom`` from the Item and the readable ``rate_line``.

Idempotent.
"""
import frappe

from upande_scp.upande_scp.doctype.spray_product_type.spray_product_type import ensure_product_types


def execute():
	ensure_product_types()
	convert_rate_rows()


def convert_rate_rows() -> int:
	"""Fill per_qty/per_uom on rows lacking them, and every Spray Product's stock_uom and line."""
	T = "`tabSpray Product Crop Rate`"
	n = 0
	for basis, qty, uom in (("Water", 1000, "Litre"), ("Hectarage", 1, "Hectare")):
		frappe.db.sql(
			f"""UPDATE {T} SET per_qty=%s, per_uom=%s
			    WHERE IFNULL(per_uom,'')='' AND IFNULL(NULLIF(basis,''),'Water')=%s""",
			(qty, uom, basis),
		)
		n += frappe.db.sql("SELECT ROW_COUNT()")[0][0]
	frappe.db.sql(
		"""UPDATE `tabSpray Product` sp JOIN `tabItem` i ON i.name = sp.item
		   SET sp.stock_uom = i.stock_uom WHERE IFNULL(sp.stock_uom,'')=''"""
	)
	from upande_scp.serverscripts.common.spray_rates import rate_line

	for r in frappe.db.sql(
		f"""SELECT c.name, c.basis, c.lower_rate_limit, c.upper_rate_limit, c.per_qty, c.per_uom,
		           IFNULL(sp.product_name, sp.item) pn, sp.stock_uom
		    FROM {T} c JOIN `tabSpray Product` sp ON sp.name = c.parent AND c.parenttype='Spray Product'""",
		as_dict=True,
	):
		line = rate_line(r.pn, r.stock_uom, r.basis or "Water", r.lower_rate_limit,
		                 r.upper_rate_limit, r.per_qty, r.per_uom)
		frappe.db.set_value("Spray Product Crop Rate", r.name, "rate_line", line, update_modified=False)
	return int(n)
