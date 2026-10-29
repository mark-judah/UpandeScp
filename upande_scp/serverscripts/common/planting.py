"""What crop is planted where, for SCP stations.

SCP keeps no planting record of its own. Resolution order for a station:

1. The station's ``custom_production_unit`` has a Production Crop Cycle covering
   the date (``start_date <= date``, status Planned / Active / Harvesting, latest
   start wins) -> its ``item`` -> the Crop Scouted whose ``production_items``
   lists that item. Only when ``upande_production`` is installed.
2. Otherwise the nearest ``custom_crop`` walking up the Warehouse tree, the
   station itself first.
3. Otherwise ``None`` (fallow / unknown).

The item -> crop link is configuration on ``Crop Scouted.production_items``. An item that is
not listed but is named ``<listed item> - <variety>`` (``Maize - H513`` beside ``Maize``) follows
the item it is a variety of.

Retired Production Units are ignored: their stations resolve to ``None``. A unit with no live
cycle of its own (a young orchard block whose cycles are not entered yet) is planted with its
own ``crop`` when that names a Crop Scouted.
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


def crop_for_item(item: str | None, item_crop: dict) -> str | None:
	"""Crop of ``item``: its own link, else the link of the item it is a variety of
	(``"Maize - H513"`` -> ``"Maize"``). Pure."""
	if not item:
		return None
	if item_crop.get(item):
		return item_crop[item]
	base = item.split(" - ", 1)[0].strip()
	return item_crop.get(base) if base != item else None


def unit_fallback_crop(unit_crop: str | None, known_crops) -> str | None:
	"""A unit's own ``crop`` when it names a Crop Scouted. Pure."""
	return unit_crop if unit_crop and unit_crop in known_crops else None


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
	meta = frappe.get_meta("Warehouse")
	has_unit = meta.has_field("custom_production_unit")
	# A site whose SCP fields haven't been created yet must still load (the crop then
	# comes only from production cycles); never select a column that isn't there.
	fields = ["name", "parent_warehouse"] + (["custom_crop"] if meta.has_field("custom_crop") else [])
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


def _unit_rows(units) -> dict:
	"""``{unit: {status, crop}}`` for Production Units."""
	if not units:
		return {}
	rows = frappe.get_all(
		"Production Unit",
		filters={"name": ["in", list(units)]},
		fields=["name", "status", "crop"],
		limit_page_length=0,
	)
	return {r["name"]: r for r in rows}


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
	unit_rows: dict = {}
	if production_available():
		units = {
			warehouses[s].get("custom_production_unit")
			for s in stations
			if s in warehouses and warehouses[s].get("custom_production_unit")
		}
		if units:
			unit_rows = _unit_rows(units)
			item_crop = _item_to_crop()
			for unit, cycles in _cycles_by_unit(units, on_date).items():
				crop = crop_for_item(pick_cycle_item(cycles, on_date), item_crop)
				if crop:
					cycle_crop[unit] = crop
			known = set(frappe.get_all("Crop Scouted", pluck="name"))
			for unit, row in unit_rows.items():
				if unit not in cycle_crop and row.get("status") != "Retired":
					fb = unit_fallback_crop(row.get("crop"), known)
					if fb:
						cycle_crop[unit] = fb

	out: dict = {}
	for s in stations:
		unit = (warehouses.get(s) or {}).get("custom_production_unit")
		if unit and (unit_rows.get(unit) or {}).get("status") == "Retired":
			out[s] = None
			continue
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
