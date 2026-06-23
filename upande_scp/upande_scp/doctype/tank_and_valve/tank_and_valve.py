# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import json

import frappe
from frappe.model.document import Document


class TankAndValve(Document):
	def validate(self):
		raw = (self.location_geojson or "").strip()
		if not raw:
			return
		try:
			geo = json.loads(raw)
		except ValueError:
			frappe.throw("Location GeoJSON is not valid JSON.")
		if not isinstance(geo, dict):
			frappe.throw("Location GeoJSON must be a Point Feature.")
		# Accept FeatureCollection (use first feature), Feature, or bare Point
		if geo.get("type") == "FeatureCollection":
			feats = geo.get("features") or []
			if not feats or not isinstance(feats[0], dict):
				frappe.throw("Location GeoJSON FeatureCollection must contain a Point Feature.")
			geom = feats[0].get("geometry")
		elif geo.get("type") == "Feature":
			geom = geo.get("geometry")
		else:
			geom = geo
		if not isinstance(geom, dict) or geom.get("type") != "Point":
			frappe.throw("Location GeoJSON must be a Point Feature.")
		coords = geom.get("coordinates")
		if not (isinstance(coords, list) and len(coords) >= 2):
			frappe.throw("Location GeoJSON Point must have [lng, lat] coordinates.")
