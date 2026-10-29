"""A trap hung on a unit: a Triad (hexagon), an Orchard Tree or a Bed / Row.

``Trap.unit_type`` + ``Trap.unit`` (Dynamic Link) say what the trap hangs on. The maps draw the
trap on that unit's geometry (the hexagon, the tree point, the bed line) and put its marker at the
unit's centre; a trap without a unit, or whose unit has no geometry yet, falls back to its own
``geojson`` point.

The geometry helpers at the top are pure (no database) so they are unit-tested directly.
"""

import json

import frappe
from frappe import _

UNIT_TYPES = ("Triad", "Orchard Tree", "Bed")
#: The field on each unit that names its station (the warehouse the trap sits in).
STATION_FIELD = {"Triad": "block", "Orchard Tree": "block", "Bed": "greenhouse"}


# ---------------------------------------------------------------- pure geometry


def geometry_of(raw):
	"""The GeoJSON geometry inside a stored value: a geometry, a Feature or a FeatureCollection
	(its first feature), as a dict or a JSON string. None when there is none."""
	if not raw:
		return None
	if isinstance(raw, str):
		try:
			raw = json.loads(raw)
		except (TypeError, ValueError):
			return None
	if not isinstance(raw, dict):
		return None
	if raw.get("type") == "FeatureCollection":
		feats = raw.get("features") or []
		return geometry_of(feats[0]) if feats else None
	if raw.get("type") == "Feature":
		return geometry_of(raw.get("geometry"))
	return raw if raw.get("type") and raw.get("coordinates") is not None else None


def _points(geometry):
	"""Every vertex of a geometry, a closed ring counted once."""
	t = (geometry or {}).get("type")
	c = (geometry or {}).get("coordinates")
	if t == "Point":
		return [c]
	if t in ("LineString", "MultiPoint"):
		return list(c or [])
	if t == "Polygon":
		ring = list((c or [[]])[0])
		return ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
	if t == "MultiLineString":
		return [p for line in c or [] for p in line]
	if t == "MultiPolygon":
		return [p for poly in c or [] for p in _points({"type": "Polygon", "coordinates": poly})]
	return []


def centre_of(geometry):
	"""(lat, lng) of a geometry's centre (the mean of its vertices), or None."""
	pts = [p for p in _points(geometry) if isinstance(p, (list, tuple)) and len(p) >= 2]
	try:
		pts = [(float(p[0]), float(p[1])) for p in pts]
	except (TypeError, ValueError):
		return None
	if not pts:
		return None
	return sum(p[1] for p in pts) / len(pts), sum(p[0] for p in pts) / len(pts)


def line_through(points):
	"""A LineString through ``[(order, lng, lat), ...]`` in order; None with fewer than two."""
	pts = sorted(points, key=lambda p: p[0])
	if len(pts) < 2:
		return None
	return {"type": "LineString", "coordinates": [[p[1], p[2]] for p in pts]}


def unit_station_field(unit_type):
	return STATION_FIELD.get(unit_type or "")


# ---------------------------------------------------------------- database side


def _bed_geometry(bed):
	"""A bed's line: its zones end to end (roses), else its hexagons' centres in order (a pivot row)."""
	pts = []
	prefix = f"{bed} - Zone "
	for z in frappe.get_all("Zone", filters={"name": ["like", f"{prefix}%"], "geojson": ["is", "set"]}, fields=["name", "geojson"]):
		tail = z.name[len(prefix):]
		g = geometry_of(z.geojson)
		if not tail.isdigit() or not g:
			continue
		for i, p in enumerate(_points(g)):
			pts.append((int(tail) * 1000 + i, float(p[0]), float(p[1])))
	if len(pts) < 2:
		pts = []
		for t in frappe.get_all("Triad", filters={"row": bed, "geojson": ["is", "set"]}, fields=["triad", "geojson"], limit_page_length=0):
			c = centre_of(geometry_of(t.geojson))
			if c:
				pts.append((t.triad or 0, c[1], c[0]))
	return line_through(pts)


def unit_geometry(unit_type, unit):
	"""The unit's geometry (GeoJSON geometry dict) or None when it has none yet."""
	if not unit or unit_type not in UNIT_TYPES or not frappe.db.exists(unit_type, unit):
		return None
	if unit_type == "Bed":
		return _bed_geometry(unit)
	row = frappe.db.get_value(unit_type, unit, ["geojson"] + (["triad"] if unit_type == "Orchard Tree" else []), as_dict=True)
	g = geometry_of(row.geojson)
	if not g and unit_type == "Orchard Tree" and row.get("triad"):
		# A tree not surveyed on its own yet sits in its hexagon.
		g = geometry_of(frappe.db.get_value("Triad", row.triad, "geojson"))
	return g


def validate_trap_unit(doc):
	"""Called from Trap.validate: a unit needs its type, and must stand in the trap's station."""
	if not doc.get("unit"):
		return  # a type with no unit is caught by the form's mandatory_depends_on
	if doc.get("unit_type") not in UNIT_TYPES:
		frappe.throw(_("Pick the unit type (Triad, Orchard Tree or Bed) for unit {0}.").format(doc.unit))
	if not frappe.db.exists(doc.unit_type, doc.unit):
		frappe.throw(_("{0} {1} does not exist.").format(doc.unit_type, doc.unit))
	station = frappe.db.get_value(doc.unit_type, doc.unit, unit_station_field(doc.unit_type))
	if doc.get("greenhouse") and station and station != doc.greenhouse:
		frappe.throw(
			_("{0} {1} is in {2}, not in this trap's station {3}.").format(doc.unit_type, doc.unit, station, doc.greenhouse)
		)
	if not doc.get("greenhouse") and station:
		doc.greenhouse = station


def trap_unit_payload(trap):
	"""What the maps need of a trap's unit: ``{unit_type, unit, unit_geometry, lat, lng}``.
	``lat``/``lng`` are the unit's centre, else the trap's own point, else None."""
	from upande_scp.serverscripts.traps import trap_geometry as G

	geo = unit_geometry(trap.get("unit_type"), trap.get("unit")) if trap.get("unit") else None
	centre = centre_of(geo) if geo else None
	if not centre:
		centre = G.point_of(trap.get("geojson")) if trap.get("geojson") else None
	return {
		"unit_type": (trap.get("unit_type") or "") if trap.get("unit") else "",
		"unit": trap.get("unit") or "",
		"unit_geometry": geo,
		"lat": centre[0] if centre else None,
		"lng": centre[1] if centre else None,
	}


@frappe.whitelist()
def set_trap_unit(trap, unit_type=None, unit=None):
	"""Hang a trap on a unit (or clear it with no ``unit``) — the desk and the phone both use this.
	Returns the trap's map payload (the unit's geometry and centre)."""
	doc = frappe.get_doc("Trap", trap)
	doc.check_permission("write")
	doc.unit_type = (unit_type or "") if unit else ""
	doc.unit = unit or ""
	doc.save()
	return {"trap": doc.name, "trap_number": doc.trap_number, **trap_unit_payload(doc.as_dict())}
