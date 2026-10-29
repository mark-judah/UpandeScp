"""What crop is planted where, for SCP stations.

SCP keeps no planting record of its own. Resolution order for a station:

1. The station's ``custom_production_unit`` has a Production Crop Cycle covering
   the date (``start_date <= date``, status Planned / Active / Harvesting, latest
   start wins) -> its ``item`` -> the Crop Scouted whose ``production_items``
   lists that item. Only when ``upande_production`` is installed.
2. Otherwise the nearest ``custom_crop`` walking up the Warehouse tree, the
   station itself first.
3. Otherwise ``None`` (fallow / unknown).

Crops are never matched by name: the item -> crop link is configuration on
``Crop Scouted.production_items``.
"""

import frappe
from frappe.utils import getdate, nowdate

LIVE_STATUSES = ("Planned", "Active", "Harvesting")

#: Safety bound on the warehouse-tree walk (a cycle in bad data must not hang).
_MAX_DEPTH = 25


def production_available() -> bool:
	return "upande_production" in frappe.get_installed_apps()


def _date(on_date):
	return getdate(on_date or nowdate())


# ---------------------------------------------------------------- pure helpers


def pick_cycle_item(cycles, on_date) -> str | None:
	"""Item of the live cycle covering ``on_date`` with the latest start.

	``cycles`` are dicts with ``item``, ``start_date``, ``status``. Pure.
	"""
	on_date = getdate(on_date)
	best = None
	for c in cycles or []:
		if c.get("status") not in LIVE_STATUSES or not c.get("item"):
			continue
		start = c.get("start_date")
		if not start or getdate(start) > on_date:
			continue
		if best is None or getdate(start) > getdate(best["start_date"]):
			best = c
	return best["item"] if best else None


def nearest_custom_crop(station: str, warehouses: dict) -> str | None:
	"""Nearest ``custom_crop`` from ``station`` up its ancestors. Pure.

	``warehouses`` maps name -> {"parent_warehouse", "custom_crop"}.
	"""
	seen = set()
	name = station
	for _ in range(_MAX_DEPTH):
		row = warehouses.get(name)
		if not row or name in seen:
			return None
		seen.add(name)
		if row.get("custom_crop"):
			return row["custom_crop"]
		name = row.get("parent_warehouse")
		if not name:
			return None
	return None


# ------------------------------------------------------------------ data loads


def _load_warehouses(stations) -> dict:
	"""``{name: row}`` for the stations and every ancestor, one query per level."""
	has_unit = frappe.get_meta("Warehouse").has_field("custom_production_unit")
	fields = ["name", "parent_warehouse", "custom_crop"]
	if has_unit:
		fields.append("custom_production_unit")
	out: dict = {}
	todo = {s for s in stations if s}
	for _ in range(_MAX_DEPTH):
		todo -= set(out)
		if not todo:
			break
		rows = frappe.get_all(
			"Warehouse",
			filters={"name": ["in", list(todo)]},
			fields=fields,
			limit_page_length=0,
		)
		for r in rows:
			out[r["name"]] = r
		todo = {r["parent_warehouse"] for r in rows if r.get("parent_warehouse")}
	return out


def _item_to_crop() -> dict:
	rows = frappe.get_all(
		"SCP Crop Production Item",
		filters={"parenttype": "Crop Scouted"},
		fields=["item", "parent"],
		order_by="parent asc, idx asc",
		limit_page_length=0,
	)
	out: dict = {}
	for r in rows:
		out.setdefault(r["item"], r["parent"])
	return out


def _cycles_by_unit(units, on_date) -> dict:
	if not units:
		return {}
	rows = frappe.get_all(
		"Production Crop Cycle",
		filters={
			"unit": ["in", list(units)],
			"status": ["in", list(LIVE_STATUSES)],
			"start_date": ["<=", on_date],
		},
		fields=["unit", "item", "start_date", "status"],
		limit_page_length=0,
	)
	by_unit: dict = {}
	for r in rows:
		by_unit.setdefault(r["unit"], []).append(r)
	return by_unit


# ------------------------------------------------------------------ public API


def crops_for_stations(stations: list, on_date=None) -> dict:
	"""``{station: crop or None}`` in a handful of queries, however many stations."""
	stations = [s for s in dict.fromkeys(stations or []) if s]
	if not stations:
		return {}
	on_date = _date(on_date)
	warehouses = _load_warehouses(stations)

	cycle_crop: dict = {}
	if production_available():
		units = {
			warehouses[s].get("custom_production_unit")
			for s in stations
			if s in warehouses and warehouses[s].get("custom_production_unit")
		}
		if units:
			item_crop = _item_to_crop()
			for unit, cycles in _cycles_by_unit(units, on_date).items():
				item = pick_cycle_item(cycles, on_date)
				if item and item_crop.get(item):
					cycle_crop[unit] = item_crop[item]

	out: dict = {}
	for s in stations:
		unit = (warehouses.get(s) or {}).get("custom_production_unit")
		out[s] = cycle_crop.get(unit) if unit else None
		if not out[s]:
			out[s] = nearest_custom_crop(s, warehouses)
	return out


def crop_for_station(station: str, on_date=None) -> str | None:
	if not station:
		return None
	return crops_for_stations([station], on_date).get(station)


def stations_for_crop(farm: str, crop: str, on_date=None) -> list:
	"""Stations of ``farm`` that resolve to ``crop`` on ``on_date``."""
	from upande_scp.serverscripts.common import farm_map

	if not farm or not crop:
		return []
	stations = farm_map.stations_for_farm(farm)
	crops = crops_for_stations(stations, on_date)
	return [s for s in stations if crops.get(s) == crop]
