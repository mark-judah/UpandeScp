"""Regenerate a pivot block's grid as Hexa → Triad at the standard side.

Mutara's pivots were surveyed as Row beds holding ~1,000 "Triads" each that are
really 3 m hexagons. This replaces them, per block, with Hexa beds holding six
equilateral triangles (Triads) at the site's standard side (`triad_side_m`, 5 m):

    bench --site mutara.local execute upande_scp.serverscripts.geo.regenerate_hexa_grid.dry_run
    bench --site mutara.local execute upande_scp.serverscripts.geo.regenerate_hexa_grid.apply \
        --kwargs "{'confirm': 1}"

The block's outline is the union of its current Triad polygons, so the new grid
covers exactly the ground the old one did. `dry_run` changes nothing and writes
its plan to `private/files/hexa_regen_dry_run.json`. `apply` works block by
block, one transaction each: traps on old Triads move to the new Triad covering
the old hexagon's centre, the old Triads and Rows go, the Hexas and Triads are
bulk-inserted, and the farm is switched to "Has Blocks"/"Has Triads". A block
already on Hexas at this side is skipped, so re-running is safe.
"""

import json
import re
import traceback

import frappe
import numpy as np
import shapely
from pyproj import Transformer
from shapely import STRtree
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

from upande_scp.serverscripts.geo.field_geo import bump_geo_version
from upande_scp.serverscripts.geo.hexa_grid import cut
from upande_scp.serverscripts.geo.triad_size import standard_side_m, triangle_side_m
from upande_scp.serverscripts.mobile.geo_utils import get_dynamic_utm_epsg
from upande_scp.upande_scp.doctype.field_unit_automation.field_unit_automation import (
	ensure_farm_levels,
)

CHUNK = 2000
AREA_TOLERANCE = 0.01
SIDE_TOLERANCE = 0.02
DRY_RUN_FILE = "hexa_regen_dry_run.json"


# --------------------------------------------------------------------------- helpers


def _natural(name):
	return [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", name or "")]


def _ring(geojson):
	"""The exterior ring [[lng, lat], ...] of a Triad's GeoJSON, or []."""
	if not geojson:
		return []
	g = json.loads(geojson) if isinstance(geojson, str) else geojson
	if g.get("type") == "FeatureCollection":
		g = (g.get("features") or [{}])[0] or {}
	if g.get("type") == "Feature":
		g = g.get("geometry") or {}
	coords = g.get("coordinates") or []
	if g.get("type") == "MultiPolygon":
		coords = coords[0] if coords else []
	return coords[0] if coords else []


def _block_outline(block):
	"""The block warehouse's own outline (custom_raw_geojson) in lng/lat, or None."""
	from shapely.geometry import shape

	raw = frappe.db.get_value("Warehouse", block, "custom_raw_geojson")
	if not raw:
		return None
	try:
		g = json.loads(raw) if isinstance(raw, str) else raw
	except ValueError:
		return None
	feats = g.get("features") if g.get("type") == "FeatureCollection" else [g]
	geoms = []
	for f in feats or []:
		geom = f.get("geometry") if f.get("type") == "Feature" else f
		if geom and geom.get("coordinates"):
			geoms.append(shapely.make_valid(shape(geom)))
	if not geoms:
		return None
	out = unary_union(geoms)
	return None if out.is_empty else out


def _project(geoms, transformer):
	def fn(xy):
		x, y = transformer.transform(xy[:, 0], xy[:, 1])
		return np.column_stack([x, y])

	return shapely.transform(np.asarray(geoms, dtype=object), fn)


def _parse_blocks(blocks):
	if not blocks:
		return None
	if isinstance(blocks, str):
		try:
			parsed = json.loads(blocks)
		except ValueError:
			parsed = [b.strip() for b in blocks.split(",") if b.strip()]
		blocks = parsed if isinstance(parsed, list) else [parsed]
	return list(blocks)


def _farm_blocks(farm):
	"""Blocks of `farm` that hold Triads (blocks with plain Rows only are left alone)."""
	names = frappe.db.sql_list(
		"""
		select distinct b.greenhouse
		from `tabTriad` t
		join `tabBed` b on b.name = t.row
		join `tabWarehouse` w on w.name = b.greenhouse
		where w.custom_farm = %s
		""",
		farm,
	)
	return sorted(names, key=_natural)


def _old_state(block):
	triads = frappe.db.sql(
		"""
		select t.name, t.row, t.geojson
		from `tabTriad` t
		join `tabBed` b on b.name = t.row
		where b.greenhouse = %s
		""",
		block,
		as_dict=True,
	)
	units = frappe.get_all(
		"Bed", filters={"greenhouse": block}, fields=["name", "unit_type"]
	)
	return triads, units


def _is_hexa_at_side(triads, units, side):
	"""True when the block holds only Hexas and its full triangles are at `side`."""
	if not units or any(u.unit_type != "Hexa" for u in units) or not triads:
		return False
	measured = None
	for t in triads:
		measured = triangle_side_m(_ring(t.geojson))
		if measured is not None:
			break
	return measured is not None and abs(measured - side) <= SIDE_TOLERANCE * side


# (doctype, column, what it points at) — any hit refuses the block.
_REFERENCES = (
	("Scouting Entry", "row", "rows"),
	("Scouting Entry", "bed", "rows"),
	("Scouting Entry", "triad", "triads"),
	("Orchard Tree", "row", "rows"),
	("Orchard Tree", "triad", "triads"),
	("Zone", "bed", "rows"),
)


def _references(old_rows, old_triads):
	"""Records outside the grid that point at the block's old units, e.g.
	["Scouting Entry.row: 3", "Trap (Bed): 1"]. Traps on old Triads are remapped,
	so only Traps on old Rows count here."""
	targets = {"rows": list(old_rows), "triads": list(old_triads)}
	hits = []
	for doctype, column, kind in _REFERENCES:
		names = targets[kind]
		if not names or not frappe.db.has_column(doctype, column):
			continue
		n = 0
		for i in range(0, len(names), 1000):
			n += frappe.db.count(doctype, {column: ("in", names[i : i + 1000])})
		if n:
			hits.append(f"{doctype}.{column}: {n}")
	if old_rows and frappe.db.has_column("Trap", "unit"):
		n = frappe.db.count("Trap", {"unit_type": "Bed", "unit": ("in", list(old_rows))})
		if n:
			hits.append(f"Trap (Bed): {n}")
	return hits


# --------------------------------------------------------------------------- planning


def _plan(block, side_m=None):
	"""(summary dict, payload for apply). Reads only."""
	side = float(side_m or standard_side_m())
	summary = {
		"block": block,
		"status": "ready",
		"outline_m2": 0.0,
		"pieces_m2": 0.0,
		"area_ok": False,
		"hexas": 0,
		"triads": 0,
		"edge_hexas": 0,
		"sample": [],
		"old_rows": 0,
		"old_triads": 0,
		"traps": [],
	}
	triads, units = _old_state(block)
	old_triads = [t.name for t in triads]
	old_rows = sorted({t.row for t in triads} | {u.name for u in units if u.unit_type == "Hexa"})
	summary["old_rows"] = len(old_rows)
	summary["old_triads"] = len(old_triads)

	if _is_hexa_at_side(triads, units, side):
		summary["status"] = "already_hexa"
		summary["reason"] = f"Already on Hexas at {side:g} m."
		return summary, None

	if not triads and units:
		summary["status"] = "refused"
		summary["reason"] = f"Block holds {len(units)} unit(s) but no Triads; a block holds one kind."
		return summary, None
	block_outline = None if triads else _block_outline(block)
	if not triads and block_outline is None:
		summary["status"] = "refused"
		summary["reason"] = "Block holds no Triads and has no outline."
		return summary, None

	stray = [u.name for u in units if u.name not in set(old_rows)]
	if stray:
		summary["status"] = "refused"
		summary["reason"] = f"{len(stray)} unit(s) hold no Triads (e.g. {stray[0]}); a block holds one kind."
		return summary, None

	refs = _references(old_rows, old_triads)
	if refs:
		summary["status"] = "refused"
		summary["reason"] = "Records reference this block's old Rows/Triads: " + ", ".join(refs) + "."
		return summary, None

	if block_outline is not None:
		# A block with no grid yet (an orchard block): cut its own outline.
		usable, old_polys = [], []
		lng0, lat0 = block_outline.exterior.coords[0] if isinstance(block_outline, Polygon) else block_outline.geoms[0].exterior.coords[0]
		epsg = get_dynamic_utm_epsg(lat0, lng0)
		fwd = Transformer.from_crs("EPSG:4326", epsg, always_xy=True)
		inv = Transformer.from_crs(epsg, "EPSG:4326", always_xy=True)
		outline = shapely.make_valid(shapely.transform(block_outline, lambda xy: np.column_stack(fwd.transform(xy[:, 0], xy[:, 1]))))
	else:
		# Old polygons, lng/lat → UTM.
		rings = [_ring(t.geojson) for t in triads]
		usable = [(t, r) for t, r in zip(triads, rings) if len(r) >= 4]
		if not usable:
			summary["status"] = "refused"
			summary["reason"] = "No Triad carries a polygon."
			return summary, None
		lng0, lat0 = usable[0][1][0][0], usable[0][1][0][1]
		epsg = get_dynamic_utm_epsg(lat0, lng0)
		fwd = Transformer.from_crs("EPSG:4326", epsg, always_xy=True)
		inv = Transformer.from_crs(epsg, "EPSG:4326", always_xy=True)
		old_polys = _project([Polygon(r) for _, r in usable], fwd)
		old_polys = shapely.make_valid(old_polys)

		outline = unary_union(old_polys).buffer(0.05).buffer(-0.05)
	pieces = cut(outline, side)

	farm = frappe.db.get_value("Warehouse", block, "custom_farm")
	geo_pieces = _project([p.polygon_utm for p in pieces], inv)

	hexas = {}
	triad_rows = []
	edge_hexas = set()
	per_hexa = {}
	for p in pieces:
		per_hexa[p.hexa_no] = per_hexa.get(p.hexa_no, 0) + 1
		if not p.full:
			edge_hexas.add(p.hexa_no)
	edge_hexas |= {n for n, c in per_hexa.items() if c < 6}

	for p, geo in zip(pieces, geo_pieces):
		hexa_name = f"{block} - Hexa {p.hexa_no}"
		hexas[p.hexa_no] = hexa_name
		name = f"{hexa_name} - Triad {p.t}"
		ring = [[round(x, 7), round(y, 7)] for x, y in geo.exterior.coords]
		if ring[0] != ring[-1]:
			ring.append(list(ring[0]))
		feature = {
			"type": "Feature",
			"properties": {
				"kind": "triad",
				"block": block,
				"hexa": p.hexa_no,
				"t": p.t,
				"name": name,
				"area_m2": round(p.polygon_utm.area, 2),
				"edge": not p.full,
			},
			"geometry": {"type": "Polygon", "coordinates": [ring]},
		}
		triad_rows.append((name, hexa_name, p.t, json.dumps(feature, separators=(",", ":"))))

	outline_m2 = outline.area
	pieces_m2 = sum(p.polygon_utm.area for p in pieces)

	# Traps on old Triads → the new Triad covering the old hexagon's centroid,
	# else the one with the nearest centroid in this block.
	trap_moves = []
	old_index = {t.name: i for i, (t, _) in enumerate(usable)}
	traps = frappe.get_all(
		"Trap",
		filters={"unit_type": "Triad", "unit": ("in", old_triads)} if old_triads else {"name": ""},
		fields=["name", "unit"],
	)
	if traps and not pieces:
		summary["status"] = "refused"
		summary["reason"] = f"{len(traps)} trap(s) on old Triads but the new grid is empty."
		return summary, None
	if traps:
		new_polys = [p.polygon_utm for p in pieces]
		tree = STRtree(new_polys)
		ctree = STRtree([g.centroid for g in new_polys])
		for trap in traps:
			i = old_index.get(trap.unit)
			if i is None:
				summary["status"] = "refused"
				summary["reason"] = f"Trap {trap.name} on {trap.unit} has no geometry."
				return summary, None
			pt = old_polys[i].centroid
			hit = tree.query(pt, predicate="within")
			j = int(hit[0]) if len(hit) else int(ctree.nearest(pt))
			trap_moves.append({"trap": trap.name, "old": trap.unit, "new": triad_rows[j][0]})

	summary.update(
		{
			"outline_m2": round(outline_m2, 1),
			"pieces_m2": round(pieces_m2, 1),
			"area_ok": outline_m2 > 0 and abs(pieces_m2 - outline_m2) <= AREA_TOLERANCE * outline_m2,
			"hexas": len(hexas),
			"triads": len(triad_rows),
			"edge_hexas": len(edge_hexas),
			"sample": [r[0] for r in triad_rows[:3]],
			"traps": trap_moves,
		}
	)
	if not summary["area_ok"]:
		summary["status"] = "refused"
		summary["reason"] = (
			f"Area check failed: pieces {pieces_m2:.1f} m² vs outline {outline_m2:.1f} m² "
			f"(tolerance {AREA_TOLERANCE:.0%})."
		)
		return summary, None
	payload = {
		"farm": farm,
		"old_rows": old_rows,
		"old_triads": old_triads,
		"hexas": sorted(hexas.items()),
		"triads": triad_rows,
		"traps": trap_moves,
	}
	return summary, payload


def plan_block(block: str, side_m: float | None = None) -> dict:
	"""What regenerating `block` would produce. Changes nothing."""
	return _plan(block, side_m)[0]


def _foreign(farm, names):
	"""Of explicitly named blocks, those not belonging to `farm` (Warehouse.custom_farm)."""
	return {b for b in names if frappe.db.get_value("Warehouse", b, "custom_farm") != farm}


def _not_in_farm(block, farm):
	return {
		"block": block, "status": "refused", "area_ok": False, "hexas": 0, "triads": 0, "edge_hexas": 0,
		"sample": [], "old_rows": 0, "old_triads": 0, "traps": [], "outline_m2": 0.0, "pieces_m2": 0.0,
		"reason": f"Block {block} does not belong to farm {farm}.",
	}


def dry_run(farm="Mutara", blocks=None) -> dict:
	frappe.only_for("System Manager")
	side = standard_side_m()
	explicit = _parse_blocks(blocks)
	names = explicit or _farm_blocks(farm)
	foreign = _foreign(farm, explicit) if explicit else set()
	plans = [_not_in_farm(b, farm) if b in foreign else plan_block(b, side) for b in names]
	result = {"side_m": side, "blocks": plans, "totals": _totals(plans)}
	path = frappe.get_site_path("private", "files", DRY_RUN_FILE)
	with open(path, "w") as fh:
		json.dump(result, fh, indent=1, default=str)
	result["file"] = path
	return result


def _totals(plans):
	ready = [p for p in plans if p["status"] == "ready"]
	return {
		"blocks": len(plans),
		"ready": len(ready),
		"already_hexa": sum(1 for p in plans if p["status"] == "already_hexa"),
		"refused": sum(1 for p in plans if p["status"] == "refused"),
		"area_ok": sum(1 for p in plans if p["area_ok"]),
		"hexas": sum(p["hexas"] for p in ready),
		"triads": sum(p["triads"] for p in ready),
		"edge_hexas": sum(p["edge_hexas"] for p in ready),
		"old_rows": sum(p["old_rows"] for p in ready),
		"old_triads": sum(p["old_triads"] for p in ready),
		"outline_m2": round(sum(p["outline_m2"] for p in ready), 1),
		"pieces_m2": round(sum(p["pieces_m2"] for p in ready), 1),
		"traps": sum(len(p["traps"]) for p in ready),
	}


# --------------------------------------------------------------------------- apply


def apply(farm="Mutara", blocks=None, confirm=0) -> dict:
	frappe.only_for("System Manager")
	if not int(confirm or 0):
		frappe.throw("Regenerating replaces the block's units. Run dry_run first, then pass confirm=1.")
	side = standard_side_m()
	explicit = _parse_blocks(blocks)
	names = explicit or _farm_blocks(farm)
	foreign = _foreign(farm, explicit) if explicit else set()
	results = []
	for block in names:
		if block in foreign:
			results.append(_not_in_farm(block, farm))
			continue
		summary, payload = _plan(block, side)
		if payload is None:
			results.append(summary)
			continue
		try:
			_write_block(block, payload)
			frappe.db.commit()
			bump_geo_version()
			summary["status"] = "applied"
		except Exception:
			frappe.db.rollback()
			summary["status"] = "failed"
			summary["reason"] = traceback.format_exc(limit=3)
		results.append(summary)
	return {"side_m": side, "blocks": results}


def _write_block(block, payload):
	# Re-check inside the write transaction, right before deleting: something may have
	# started pointing at the old units since the plan was made.
	refs = _references(payload["old_rows"], payload.get("old_triads") or [])
	if refs:
		frappe.throw("Records now reference this block's old Rows/Triads: " + ", ".join(refs) + ".")

	ensure_farm_levels(block, "Hexa")

	old_rows = payload["old_rows"]
	if old_rows:
		frappe.db.delete("Triad", {"row": ("in", old_rows)})
		frappe.db.delete("Bed", {"name": ("in", old_rows)})

	now = frappe.utils.now_datetime()
	user = frappe.session.user
	farm = payload["farm"]
	std = ["name", "creation", "modified", "owner", "modified_by", "docstatus", "idx"]

	frappe.db.bulk_insert(
		"Bed",
		[*std, "greenhouse", "unit_type", "bed", "farm"],
		[(name, now, now, user, user, 0, 0, block, "Hexa", n, farm) for n, name in payload["hexas"]],
		chunk_size=CHUNK,
	)
	frappe.db.bulk_insert(
		"Triad",
		[*std, "row", "triad", "block", "farm", "geojson"],
		[
			(name, now, now, user, user, 0, 0, hexa, t, block, farm, geojson)
			for name, hexa, t, geojson in payload["triads"]
		],
		chunk_size=CHUNK,
	)
	for move in payload["traps"]:
		frappe.db.set_value("Trap", move["trap"], "unit", move["new"])


# --------------------------------------------------------------------------- remote trigger


@frappe.whitelist(methods=["POST"])
def run_for_farm(farm: str = "Mutara", blocks=None, confirm: int = 0) -> dict:
	"""The same dry run / apply over HTTP, for sites without a bench shell (Frappe Cloud).

	System Manager only (dry_run/apply check it again). confirm=0 returns the dry run's
	totals and per-block status; confirm=1 queues the apply as a long background job
	(400k Triads do not fit a web request) and returns its job id."""
	frappe.only_for("System Manager")
	if not int(confirm or 0):
		r = dry_run(farm, blocks)
		return {
			"totals": r["totals"],
			"blocks": [{k: p.get(k) for k in ("block", "status", "hexas", "triads", "reason")} for p in r["blocks"]],
		}
	job = frappe.enqueue(
		"upande_scp.serverscripts.geo.regenerate_hexa_grid.apply",
		queue="long", timeout=6 * 3600, farm=farm, blocks=blocks, confirm=1,
	)
	return {"queued": True, "job": getattr(job, "id", None)}
