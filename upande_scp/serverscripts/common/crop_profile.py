"""What kind of crop each scouted crop is, read from where it is planted.

The desk used to branch on crop *names* ("avocado" and "coffee" are grown on
blocks, everything else on greenhouses). That cannot follow a site that grows
Potato, Onion, Cabbage and Passion Fruit on pivots, and the project rule is that
crops are never classified by a name list. So the profile is derived from data:

* ``station_type`` is the most common ``warehouse_type`` of the stations that
  resolve to the crop (``common.planting``), falling back to the stations of the
  crop's farms when nothing resolves yet (a site with no ``custom_crop`` set).
* ``block_grown`` is ``station_type`` not being the greenhouse type.
* ``level_labels`` are the warehouse types of the group levels between the farm
  root and the stations, top first (``["Phase", "Section"]``, ``["Pivot"]``).

Everything is batched: one query for the crops, one for their farms, one for the
farms' warehouses, and one per tree level for the ancestors.
"""

from __future__ import annotations

from collections import Counter

import frappe

from upande_scp.serverscripts.common import crop_scope, farm_map, planting

_MAX_DEPTH = 25


def slug(label: str) -> str:
	"""Same rule as the router's ``cropSlug``: ``Passion Fruit`` -> ``passion-fruit``."""
	return "-".join((label or "").strip().lower().split())


def _levels_above(station: str, warehouses: dict) -> list:
	"""Warehouse types of ``station``'s non-root ancestors, top first. Pure."""
	chain: list[str] = []
	seen = {station}
	name = (warehouses.get(station) or {}).get("parent_warehouse")
	for _ in range(_MAX_DEPTH):
		row = warehouses.get(name) if name else None
		if not row or name in seen:
			break
		seen.add(name)
		# The root is the farm itself, not a level inside it.
		if row.get("parent_warehouse"):
			chain.append(row.get("warehouse_type") or "")
		name = row.get("parent_warehouse")
	return [t for t in reversed(chain) if t]


def _most_common(items):
	return Counter(items).most_common(1)[0][0] if items else None


def build_profiles(crops, crop_farms, stations, resolved, warehouses, greenhouse_type) -> list:
	"""Fold the loaded rows into one profile per crop. Pure.

	``crops``       [{"name", "crop_name"}]
	``crop_farms``  {crop: set(farm)}
	``stations``    [{"name", "warehouse_type", "custom_farm"}]
	``resolved``    {station: crop or None}   (planting.crops_for_stations)
	``warehouses``  {name: {"parent_warehouse", "warehouse_type"}} incl. ancestors
	"""
	out = []
	for c in crops:
		name = c["name"]
		label = (c.get("crop_name") or name).strip()
		mine = [s for s in stations if resolved.get(s["name"]) == name]
		if not mine:
			farms = crop_farms.get(name) or set()
			mine = [
				s for s in stations
				if s.get("custom_farm") in farms and not resolved.get(s["name"])
			]
		station_type = _most_common([s["warehouse_type"] for s in mine]) or ""
		of_type = [s for s in mine if s["warehouse_type"] == station_type]
		level_labels = _most_common(
			[tuple(_levels_above(s["name"], warehouses)) for s in of_type]
		)
		out.append(
			{
				"crop": name,
				"label": label,
				"slug": slug(label),
				"station_type": station_type,
				"block_grown": bool(station_type) and station_type != greenhouse_type,
				"level_labels": list(level_labels or ()),
			}
		)
	return out


def _load_ancestors(stations) -> dict:
	"""``{name: {parent_warehouse, warehouse_type}}`` for stations and ancestors."""
	out: dict = {}
	todo = {s for s in stations if s}
	for _ in range(_MAX_DEPTH):
		todo -= set(out)
		if not todo:
			break
		rows = frappe.get_all(
			"Warehouse",
			filters={"name": ["in", list(todo)]},
			fields=["name", "parent_warehouse", "warehouse_type"],
			limit_page_length=0,
		)
		for r in rows:
			out[r["name"]] = r
		todo = {r["parent_warehouse"] for r in rows if r.get("parent_warehouse")}
	return out


def compute_profiles(on_date=None) -> list:
	crops = frappe.get_all(
		"Crop Scouted", fields=["name", "crop_name"], order_by="crop_name asc", limit_page_length=0
	)
	if not crops:
		return []
	farm_rows = frappe.get_all(
		"Farm Filter",
		filters={"parenttype": "Crop Scouted"},
		fields=["parent", "farm"],
		limit_page_length=0,
		ignore_permissions=True,
	)
	crop_farms: dict = {}
	for r in farm_rows:
		if r.get("farm"):
			crop_farms.setdefault(r["parent"], set()).add(r["farm"])
	all_farms = set().union(*crop_farms.values()) if crop_farms else set()

	types = farm_map.station_types()
	stations = []
	if all_farms:
		rows = frappe.get_all(
			"Warehouse",
			filters={"custom_farm": ["in", list(all_farms)], "disabled": 0},
			fields=["name", "warehouse_type", "is_group", "custom_farm"],
			limit_page_length=0,
		)
		stations = [r for r in rows if farm_map.is_station(r, types)]
	names = [s["name"] for s in stations]
	resolved = planting.crops_for_stations(names, on_date)
	warehouses = _load_ancestors(names)
	return build_profiles(
		crops, crop_farms, stations, resolved, warehouses, farm_map.GREENHOUSE_TYPE
	)


@frappe.whitelist()
def get_crop_profiles() -> list:
	"""[{crop, label, slug, station_type, block_grown, level_labels}] per scouted crop.

	Narrowed to the crops the user may see, like ``get_crops_with_farms``.
	"""
	allowed = crop_scope.allowed_crops(frappe.session.user)
	rows = compute_profiles()
	if allowed is None:
		return rows
	return [r for r in rows if r["crop"] in allowed]
