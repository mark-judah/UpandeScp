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
		# Accept either a Feature or a bare Point geometry
		geom = geo.get("geometry") if isinstance(geo, dict) and geo.get("type") == "Feature" else geo
		if not isinstance(geom, dict) or geom.get("type") != "Point":
			frappe.throw("Location GeoJSON must be a Point Feature.")
		coords = geom.get("coordinates")
		if not (isinstance(coords, list) and len(coords) >= 2):
			frappe.throw("Location GeoJSON Point must have [lng, lat] coordinates.")
