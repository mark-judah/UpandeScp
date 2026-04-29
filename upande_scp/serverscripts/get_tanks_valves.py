"""Tanks & Valves FeatureCollection for the avocado 3D map.

Cached in Redis per-farm (key suffixed with farm name) and invalidated on
Tank And Valve doc changes via the hooks.py wiring.
"""

import json

import frappe

from upande_scp.serverscripts.cache_utils import (
	K_TANKS_VALVES_PREFIX,
	TTL_LONG,
	get_or_set,
)


def _features_from_rows(rows):
	features = []
	for r in rows:
		raw = (r.get("location_geojson") or "").strip()
		if not raw:
			continue
		try:
			geo = json.loads(raw)
		except (TypeError, ValueError):
			continue
		if not isinstance(geo, dict):
			continue
		# Allow either Feature or bare Point geometry
		if geo.get("type") == "Feature":
			feat = geo
		elif geo.get("type") == "Point":
			feat = {"type": "Feature", "geometry": geo, "properties": {}}
		else:
			continue
		props = feat.setdefault("properties", {})
		props["asset_name"] = r["name"]
		props["asset_label"] = r.get("asset_label") or r["name"]
		props["asset_type"] = r.get("asset_type") or "Tank"
		props["height"] = float(r.get("height") or 0) or None
		props["radius"] = float(r.get("radius") or 0) or None
		props["farm"] = r.get("farm") or ""
		props["block"] = r.get("block") or ""
		features.append(feat)
	return features


def _build_for_farm(farm):
	filters = {}
	if farm:
		filters["farm"] = farm
	rows = frappe.get_all(
		"Tank And Valve",
		filters=filters,
		fields=[
			"name", "asset_label", "asset_type",
			"farm", "block", "height", "radius", "location_geojson",
		],
		limit_page_length=0,
	)
	return {"type": "FeatureCollection", "features": _features_from_rows(rows)}


@frappe.whitelist()
def get_tanks_valves_geojson(farm=None):
	farm = farm or frappe.form_dict.get("farm") or ""
	key = f"{K_TANKS_VALVES_PREFIX}:{farm or '__all__'}"
	return get_or_set(key, lambda: _build_for_farm(farm), ttl=TTL_LONG)
