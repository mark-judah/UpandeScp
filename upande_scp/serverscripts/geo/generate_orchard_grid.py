"""Generate avocado rows and trees for blocks that only have an outline.

Lokitela's model, reproduced: a block (Warehouse) has Row records (``Bed`` with
``unit_type = Row``, named ``<block> - Row <r>``) and Orchard Trees named
``<block> - Row <r> - Tree <t>`` whose ``geojson`` is a Point Feature. Rows are straight and
parallel, trees even along a row, numbered 1..n in ONE direction for every row (not serpentine:
Lokitela's Tree 1 is on the same side in every row), so ``get_orchard_tree_rows`` stores a row as
two endpoints (LINEAR).

Method (per block, in a local metric plane around the outline's centroid, x = east, y = north):

* orientation = the LONGEST SIDE of the outline. A clean outline (<= 12 vertices) uses its longest
  edge directly. A noisy one (more vertices) uses the long axis of its minimum-area rotated
  rectangle instead, since its single longest edge would be an artefact of the digitising.
* the row direction is turned to point west -> east (north -> south when vertical), so Tree 1 is
  at the west end of every row;
* rows are lines parallel to that side, the first ``between_rows_m / 2`` inside it, then every
  ``between_rows_m``; Row 1 is the one nearest the longest side, the numbering runs inward;
* trees sit on a grid every ``in_row_m`` along each row (anchored at the same origin in every row,
  so the orchard is a true grid), only where the point is inside the outline and at least half a
  spacing from its boundary (no tree on the fence); a row's trees are numbered west to east.
  Rows left with no tree are dropped and the rest renumbered 1..R without gaps.

Usage (bench console / execute):

    bench --site mutara.local execute upande_scp.serverscripts.geo.generate_orchard_grid.run \
        --kwargs '{"dry_run": 1}'
"""

import json
import math
import time

import frappe

IN_ROW_M = 4.0
BETWEEN_ROWS_M = 6.0
M_PER_DEG = 111_320.0  # metres per degree of latitude (and of longitude at the equator)
CLEAN_VERTICES = 12  # an outline with at most this many vertices is read edge by edge


# ------------------------------------------------------------------ pure geometry


def project(ring, lng0, lat0):
	"""lng/lat -> local metres (x east, y north), equirectangular around (lng0, lat0)."""
	k = M_PER_DEG * math.cos(math.radians(lat0))
	return [((lng - lng0) * k, (lat - lat0) * M_PER_DEG) for lng, lat in ring]


def unproject(pt, lng0, lat0):
	k = M_PER_DEG * math.cos(math.radians(lat0))
	return (lng0 + pt[0] / k, lat0 + pt[1] / M_PER_DEG)


def open_ring(ring):
	ring = [tuple(p[:2]) for p in ring]
	if len(ring) > 1 and ring[0] == ring[-1]:
		ring = ring[:-1]
	return ring


def polygon_area(ring):
	a = 0.0
	n = len(ring)
	for i in range(n):
		x1, y1 = ring[i]
		x2, y2 = ring[(i + 1) % n]
		a += x1 * y2 - x2 * y1
	return abs(a) / 2


def centroid(ring):
	"""Area centroid of a simple polygon (falls back to the vertex mean when degenerate)."""
	a = 0.0
	cx = cy = 0.0
	n = len(ring)
	for i in range(n):
		x1, y1 = ring[i]
		x2, y2 = ring[(i + 1) % n]
		c = x1 * y2 - x2 * y1
		a += c
		cx += (x1 + x2) * c
		cy += (y1 + y2) * c
	if abs(a) < 1e-9:
		return (sum(p[0] for p in ring) / n, sum(p[1] for p in ring) / n)
	return (cx / (3 * a), cy / (3 * a))


def longest_side(ring):
	"""(length_m, bearing_deg_from_north_0_180, (ux, uy)) of the longest edge; unit vector west->east."""
	best = None
	n = len(ring)
	for i in range(n):
		x1, y1 = ring[i]
		x2, y2 = ring[(i + 1) % n]
		d = math.hypot(x2 - x1, y2 - y1)
		if best is None or d > best[0]:
			best = (d, x2 - x1, y2 - y1)
	d, dx, dy = best
	return d, _bearing(dx, dy), _orient(dx / d, dy / d)


def _orient(ux, uy):
	"""Point the direction west -> east (north -> south for a vertical one)."""
	if ux < -1e-9 or (abs(ux) <= 1e-9 and uy > 0):
		return (-ux, -uy)
	return (ux, uy)


def _bearing(dx, dy):
	return round(math.degrees(math.atan2(dx, dy)) % 180, 1)


def _hull(points):
	pts = sorted(set(points))
	if len(pts) < 3:
		return pts

	def cross(o, a, b):
		return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

	lo, up = [], []
	for p in pts:
		while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
			lo.pop()
		lo.append(p)
	for p in reversed(pts):
		while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0:
			up.pop()
		up.append(p)
	return lo[:-1] + up[:-1]


def long_axis_of_min_rect(ring):
	"""(length_m, bearing, unit) of the long axis of the minimum-area rotated rectangle."""
	hull = _hull(ring)
	best = None
	n = len(hull)
	for i in range(n):
		x1, y1 = hull[i]
		x2, y2 = hull[(i + 1) % n]
		d = math.hypot(x2 - x1, y2 - y1)
		if d == 0:
			continue
		ux, uy = (x2 - x1) / d, (y2 - y1) / d
		ts = [(p[0] - x1) * ux + (p[1] - y1) * uy for p in hull]
		ns = [-(p[0] - x1) * uy + (p[1] - y1) * ux for p in hull]
		w, h = max(ts) - min(ts), max(ns) - min(ns)
		if best is None or w * h < best[0]:
			best = (w * h, w, h, ux, uy)
	_, w, h, ux, uy = best
	if h > w:
		ux, uy, w = -uy, ux, h
	return w, _bearing(ux, uy), _orient(ux, uy)


def orientation(ring):
	"""Row direction of an outline: (method, length_m, bearing, unit)."""
	if len(ring) <= CLEAN_VERTICES:
		return ("longest-edge",) + longest_side(ring)
	return ("min-rect-long-axis",) + long_axis_of_min_rect(ring)


def point_in_polygon(pt, ring):
	x, y = pt
	inside = False
	n = len(ring)
	j = n - 1
	for i in range(n):
		xi, yi = ring[i]
		xj, yj = ring[j]
		if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
			inside = not inside
		j = i
	return inside


def dist_to_boundary(pt, ring):
	x, y = pt
	best = float("inf")
	n = len(ring)
	for i in range(n):
		x1, y1 = ring[i]
		x2, y2 = ring[(i + 1) % n]
		dx, dy = x2 - x1, y2 - y1
		L2 = dx * dx + dy * dy
		t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
		best = min(best, math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)))
	return best


def plan_grid(ring, unit, in_row_m=IN_ROW_M, between_rows_m=BETWEEN_ROWS_M):
	"""Rows of tree positions (local metres) for an outline ring and a unit row direction.

	Returns a list of rows, each a list of (x, y) ordered Tree 1..n (west -> east). Row 1 is the
	row nearest the longest side; the rest follow inward.
	"""
	ux, uy = unit
	inset = min(in_row_m, between_rows_m) / 2.0
	ts = [p[0] * ux + p[1] * uy for p in ring]
	# Perpendicular axis pointing from the longest side towards the rest of the block.
	nx, ny = -uy, ux
	ds = [p[0] * nx + p[1] * ny for p in ring]
	# The longest side is the edge the orientation came from: the extreme of the two perpendicular
	# sides that holds more of its length; the generic, robust choice is the nearer-to-longest edge.
	side_d = _longest_side_offset(ring, unit)
	flip = side_d > (min(ds) + max(ds)) / 2
	if flip:
		nx, ny = -nx, -ny
		ds = [-d for d in ds]
		side_d = -side_d
	t_min = min(ts)
	rows = []
	d = side_d + between_rows_m / 2.0
	d_max = max(ds)
	while d <= d_max:
		pts = []
		t = t_min + in_row_m / 2.0
		t_max = max(ts)
		while t <= t_max:
			x = t * ux + d * nx
			y = t * uy + d * ny
			if point_in_polygon((x, y), ring) and dist_to_boundary((x, y), ring) >= inset:
				pts.append((x, y))
			t += in_row_m
		if pts:
			rows.append(pts)
		d += between_rows_m
	return rows


def _longest_side_offset(ring, unit):
	"""Perpendicular coordinate (along the unit's normal) of the longest edge's line."""
	nx, ny = -unit[1], unit[0]
	best = None
	n = len(ring)
	for i in range(n):
		x1, y1 = ring[i]
		x2, y2 = ring[(i + 1) % n]
		L = math.hypot(x2 - x1, y2 - y1)
		parallel = abs((x2 - x1) * unit[0] + (y2 - y1) * unit[1]) / L if L else 0
		# longest edge among those (nearly) parallel to the chosen direction
		if parallel > 0.97 and (best is None or L > best[0]):
			best = (L, ((x1 + x2) / 2) * nx + ((y1 + y2) / 2) * ny)
	if best is None:  # direction came from a rotated rectangle: use the nearest extreme
		return min(p[0] * nx + p[1] * ny for p in ring)
	return best[1]


def tree_name(block, row, tree):
	return f"{block} - Row {row} - Tree {tree}"


def row_name(block, row):
	return f"{block} - Row {row}"


def point_feature(lng, lat, name):
	return json.dumps(
		{"type": "Feature", "geometry": {"type": "Point", "coordinates": [lng, lat]}, "properties": {"name": name}}
	)


def outline_ring(raw):
	"""The outer ring [(lng, lat)] of a Warehouse.custom_raw_geojson (Feature, FeatureCollection or geometry)."""
	if not raw:
		return None
	try:
		g = json.loads(raw)
	except (TypeError, ValueError):
		return None
	if g.get("type") == "FeatureCollection":
		g = (g.get("features") or [None])[0] or {}
	geom = g.get("geometry") or g
	coords = geom.get("coordinates") or []
	if geom.get("type") == "MultiPolygon" and coords:
		coords = max(coords, key=lambda p: len(p[0]))
	if not coords or not coords[0]:
		return None
	return open_ring(coords[0])


def block_plan(ring_lnglat, in_row_m=IN_ROW_M, between_rows_m=BETWEEN_ROWS_M):
	"""Everything the generator and the dry run need for one outline."""
	lng0 = sum(p[0] for p in ring_lnglat) / len(ring_lnglat)
	lat0 = sum(p[1] for p in ring_lnglat) / len(ring_lnglat)
	ring = project(ring_lnglat, lng0, lat0)
	method, length, bearing, unit = orientation(ring)
	rows = plan_grid(ring, unit, in_row_m, between_rows_m)
	return {
		"method": method,
		"side_m": length,
		"bearing": bearing,
		"area_ha": polygon_area(ring) / 10_000,
		"rows": [[unproject(p, lng0, lat0) for p in r] for r in rows],
	}


# ------------------------------------------------------------------ site side


def avocado_blocks(farm=None, block=None):
	"""Block warehouses under a Phase (avocado) that carry an outline."""
	if block:
		names = [block]
	else:
		filters = {"warehouse_type": "Block", "disabled": 0}
		if farm:
			filters["custom_farm"] = farm
		names = frappe.get_all("Warehouse", filters=filters, pluck="name", order_by="name")
	out = []
	for n in names:
		if not _under_phase(n):
			continue
		w = frappe.db.get_value("Warehouse", n, ["name", "custom_farm", "custom_area_ha", "custom_raw_geojson"], as_dict=True)
		if w:
			out.append(w)
	return out


def _under_phase(name):
	seen = 0
	while name and seen < 10:
		wt, parent = frappe.db.get_value("Warehouse", name, ["warehouse_type", "parent_warehouse"])
		if wt == "Phase":
			return True
		if wt == "Pivot":
			return False
		name, seen = parent, seen + 1
	return False


def _scouted_trees(block):
	"""Orchard Trees of the block that a Scouting Entry points at (never deleted)."""
	return set(
		frappe.db.sql_list(
			"select distinct tree from `tabScouting Entry` where block=%s and tree is not null and tree != ''", block
		)
	)


def _clear_caches(blocks, farms):
	from upande_scp.serverscripts.common import cache_utils as cu

	for b in blocks:
		cu.invalidate_orchard_trees_for_block(b)
		cu.invalidate(f"{cu.K_STATION_GRID_PREFIX}:{b}", f"{cu.K_STATION_RANKS_PREFIX}:{b}")
	for f in farms:
		cu.invalidate(
			f"{cu.K_ORCHARD_TREES_PREFIX}:farm:{f}",
			f"{cu.K_ORCHARD_TREES_PREFIX}:pts:farm:{f}",
			f"{cu.K_ORCHARD_TREES_PREFIX}:rows:farm:{f}",
		)
		cu.invalidate_farm_bundle(f)
	cu.invalidate_scouting_payload()


def run(farm=None, block=None, in_row_m=4, between_rows_m=6, dry_run=1, replace=0):
	"""Generate rows and trees. Idempotent: a block that already has trees is skipped unless replace=1
	(then only its generated rows/trees go, and trees a Scouting Entry points at are kept)."""
	in_row_m, between_rows_m = float(in_row_m), float(between_rows_m)
	dry_run, replace = int(dry_run), int(replace)
	report = []
	tot = {"blocks": 0, "rows": 0, "trees": 0}
	touched, farms = [], set()
	for w in avocado_blocks(farm, block):
		ring = outline_ring(w.custom_raw_geojson)
		if not ring or len(ring) < 3:
			report.append(f"{w.name}: skipped, no outline")
			continue
		existing = frappe.db.count("Orchard Tree", {"block": w.name})
		if existing and not replace:
			report.append(f"{w.name}: skipped, already has {existing} trees (replace=1 to regenerate)")
			continue
		plan = block_plan(ring, in_row_m, between_rows_m)
		n_trees = sum(len(r) for r in plan["rows"])
		expect = (w.custom_area_ha or plan["area_ha"]) * 10_000 / (in_row_m * between_rows_m)
		report.append(
			f"{w.name}: {plan['method']} side {plan['side_m']:.0f} m bearing {plan['bearing']:.0f}deg, "
			f"outline {plan['area_ha']:.2f} ha (field {w.custom_area_ha or 0:.2f}), rows {len(plan['rows'])}, "
			f"trees {n_trees} (expected ~{expect:.0f}, {n_trees / expect * 100 if expect else 0:.0f}%)"
		)
		tot["blocks"] += 1
		tot["rows"] += len(plan["rows"])
		tot["trees"] += n_trees
		if dry_run:
			continue
		t0 = time.time()
		kept = _replace_existing(w.name) if existing or replace else 0
		if kept:
			report.append(f"{w.name}: kept {kept} trees that scouting entries point at; generated rows skip those names")
		_insert(w, plan, skip=_scouted_names(w.name) if kept else set())
		touched.append(w.name)
		farms.add(w.custom_farm)
		report.append(f"{w.name}: written in {time.time() - t0:.1f}s")
	if not dry_run:
		frappe.db.commit()
		_clear_caches(touched, farms)
	for line in report:
		print(line)
	print(f"{'DRY RUN' if dry_run else 'APPLIED'}: {tot['blocks']} blocks, {tot['rows']} rows, {tot['trees']} trees")
	return tot


def _scouted_names(block):
	return _scouted_trees(block)


def _replace_existing(block):
	"""Delete the block's trees and Row beds except trees that scouting entries use. Returns kept count."""
	keep = _scouted_trees(block)
	trees = frappe.db.sql_list("select name from `tabOrchard Tree` where block=%s", block)
	drop = [t for t in trees if t not in keep]
	for i in range(0, len(drop), 5000):
		frappe.db.delete("Orchard Tree", {"name": ["in", drop[i : i + 5000]]})
	keep_rows = {frappe.db.get_value("Orchard Tree", t, "row") for t in keep}
	rows = frappe.db.sql_list("select name from tabBed where greenhouse=%s and unit_type='Row'", block)
	for r in rows:
		if r not in keep_rows:
			frappe.db.delete("Bed", {"name": r})
	return len(keep)


def _insert(w, plan, skip=()):
	block, farm = w.name, w.custom_farm
	now = frappe.utils.now()
	user = frappe.session.user
	common = [now, now, user, user, 0, 0]
	bed_fields = ["name", "creation", "modified", "modified_by", "owner", "docstatus", "idx",
		"greenhouse", "unit_type", "bed", "farm"]
	tree_fields = ["name", "creation", "modified", "modified_by", "owner", "docstatus", "idx",
		"row", "block", "tree_number", "tree", "farm", "geojson", "is_model"]
	existing_rows = set(frappe.db.sql_list("select name from tabBed where greenhouse=%s", block))
	beds, trees = [], []
	for r, pts in enumerate(plan["rows"], 1):
		rn = row_name(block, r)
		if rn not in existing_rows:
			beds.append(tuple([rn] + common + [block, "Row", r, farm]))
		for t, (lng, lat) in enumerate(pts, 1):
			name = tree_name(block, r, t)
			if name in skip:
				continue
			trees.append(tuple([name] + common + [rn, block, str(t), t, farm, point_feature(lng, lat, name), 0]))
	if beds:
		frappe.db.bulk_insert("Bed", bed_fields, beds, ignore_duplicates=True)
	for i in range(0, len(trees), 2000):
		frappe.db.bulk_insert("Orchard Tree", tree_fields, trees[i : i + 2000], ignore_duplicates=True)
