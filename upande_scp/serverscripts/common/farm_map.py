"""Which farm a warehouse belongs to.

``Warehouse.custom_farm`` is the only warehouse -> Farm edge that exists. This
module is the single place that reads it, so nothing else has to guess.

## Why this replaced parsing the warehouse name

The code used to derive the farm from the greenhouse's *name* — a regex for
everything before " GH", a split on " - ", a case-insensitive substring test.
That is a guess dressed as a lookup, and on kaitet it is wrong for **51 of the
158** greenhouse warehouses that carry a link::

    warehouse                        parsed        linked farm
    "_Test SCP Units GH 01 - KR"     "_Test SCP Units"   "_Test SCP Units Farm"
    "Kapkolia Wetland GH 3 - KR"     "Kapkolia Wetland"  "Kapkolia"
    "Torongo CSU Phase 1 - KR"       "Torongo CSU Phase 1 - KR"  "Torongo"

Each mismatch is a greenhouse silently filed under a farm that does not exist,
which is invisible until somebody filters by farm and sees an empty list. It
also hardcodes one site's naming convention into an app that has to install
anywhere: a site that names greenhouses "GH-01/Chepsito" gets nothing at all.

The 18 unlinked greenhouses on kaitet all have zero Work Orders, so nothing is
lost by refusing to guess for them. An unlinked warehouse resolves to ``None``
and is simply absent from farm-scoped results — a visible gap somebody can fix
on the Warehouse record, rather than a wrong answer nobody notices.
"""

import frappe

#: Warehouses that hold a crop. Used where a caller wants "the greenhouses of
#: this farm" rather than every warehouse attached to it (stores, transit, ...).
GREENHOUSE_TYPE = "Greenhouse"


def farm_for_warehouse(warehouse: str | None) -> str | None:
	"""The Farm this warehouse belongs to, or None when it is not linked."""
	if not warehouse:
		return None
	return frappe.db.get_value("Warehouse", warehouse, "custom_farm") or None


def farms_for_warehouses(warehouses) -> dict:
	"""``{warehouse: farm}`` for many warehouses in one query.

	The per-row form is an N+1 when a result set carries hundreds of work
	orders, which is exactly where the old name-parse was used precisely because
	it needed no query at all.
	"""
	names = [w for w in set(warehouses or []) if w]
	if not names:
		return {}
	rows = frappe.get_all(
		"Warehouse",
		filters={"name": ["in", names]},
		fields=["name", "custom_farm"],
		limit_page_length=0,
	)
	return {r["name"]: (r["custom_farm"] or None) for r in rows}


def warehouses_for_farm(farm: str | None, warehouse_type: str | None = None) -> list:
	"""Non-disabled warehouses linked to ``farm``, optionally of one type."""
	if not farm:
		return []
	filters = {"custom_farm": farm, "disabled": 0}
	if warehouse_type:
		filters["warehouse_type"] = warehouse_type
	return frappe.get_all(
		"Warehouse", filters=filters, pluck="name", order_by="name asc", limit_page_length=0
	)


def greenhouses_for_farm(farm: str | None) -> list:
	"""Greenhouse warehouses of ``farm``."""
	return warehouses_for_farm(farm, GREENHOUSE_TYPE)


def greenhouses_for_farms(farms) -> list:
	"""Greenhouse warehouses across several farms, in one query."""
	names = [f for f in set(farms or []) if f]
	if not names:
		return []
	return frappe.get_all(
		"Warehouse",
		filters={
			"custom_farm": ["in", names],
			"warehouse_type": GREENHOUSE_TYPE,
			"disabled": 0,
		},
		pluck="name",
		order_by="name asc",
		limit_page_length=0,
	)
