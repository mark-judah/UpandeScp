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


# ---------------------------------------------------------------------------
# Which warehouses are scouting stations
#
# "Every non-group warehouse of the farm" was the old answer, and it is how a
# stock-only warehouse with no beds — `Torongo GH18 - KR` — reached a scout's
# picker and cost her six days of captures. It also offered chemical stores,
# CSUs and transit warehouses as places to scout.
#
# A station is a warehouse of a type that has field units under it. Which types
# those are is configuration, not a constant: roses call it a Greenhouse, avocado
# and coffee call it a Block, and the next crop will bring its own word.
# ---------------------------------------------------------------------------

#: Used when the setting has never been filled in. The same pair the rest of the
#: app already hardcodes, so an un-migrated site behaves exactly as before.
DEFAULT_STATION_TYPES = ("Greenhouse", "Block")

#: A Block is routinely `is_group = 1` because its rows hang beneath it, and it
#: is still the station beds and traps link to. Every other type must be a leaf:
#: `Torongo Greenhouses - KR` is a folder, not a place to scout.
_GROUPS_ALLOWED = ("Block",)


def station_types_from_rows(rows) -> tuple:
	"""The configured types, from the settings child rows. Pure.

	Blank rows are dropped rather than treated as a wildcard — an empty grid line
	must not quietly re-open the list to every warehouse on the farm.
	"""
	seen: list[str] = []
	for row in rows or []:
		value = (row.get("warehouse_type") or "").strip() if isinstance(row, dict) else ""
		if value and value not in seen:
			seen.append(value)
	return tuple(seen) if seen else DEFAULT_STATION_TYPES


def station_types() -> tuple:
	"""The configured station types for this site."""
	try:
		rows = frappe.get_all(
			"SCP Station Warehouse Type",
			filters={"parenttype": "Scouting and Crop Protection Settings"},
			fields=["warehouse_type"],
		)
	except Exception:
		# The child table may not exist yet on a site mid-migration.
		return DEFAULT_STATION_TYPES
	return station_types_from_rows(rows)


def is_station(warehouse, types=None) -> bool:
	"""Is this warehouse a place a scout can be sent to?

	``warehouse`` is a dict or Frappe row carrying ``warehouse_type`` and
	``is_group``.
	"""
	types = types or station_types()
	wt = warehouse.get("warehouse_type") if hasattr(warehouse, "get") else None
	if not wt or wt not in types:
		return False
	is_group = warehouse.get("is_group") if hasattr(warehouse, "get") else 0
	return (not is_group) or wt in _GROUPS_ALLOWED


def stations_for_farm(farm: str | None) -> list:
	"""Every warehouse of ``farm`` a scout can be sent to."""
	if not farm:
		return []
	rows = frappe.get_all(
		"Warehouse",
		filters={"custom_farm": farm, "disabled": 0},
		fields=["name", "warehouse_type", "is_group"],
		order_by="name asc",
		limit_page_length=0,
	)
	types = station_types()
	return [r["name"] for r in rows if is_station(r, types)]
