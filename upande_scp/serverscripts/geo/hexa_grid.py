"""Cut a field outline into a pointy-top hexagon lattice of six triangles each.

Pure geometry, in metres (a projected CRS). No Frappe here, so it is cheap to test.

Rules (see the hexa/triad design):

* The lattice origin is the outline's north-west corner `(minx, maxy)`; hexa rows
  run north → south, every odd row shifted east by half a hexa width.
* A hexa is pointy-top with circumradius = `side_m`. Triangle slot `t` (k = t-1)
  is `[centre, V(30° + 60°k), V(30° + 60°(k+1)), centre]`, angles CCW from east,
  so slot 1 is the top-right triangle and its centroid bears 60°.
* Triangles wholly inside the outline are kept as they are (`full`). The others
  are clipped to it; a clipped MultiPolygon keeps its largest part, and pieces
  under 0.5 m² are dropped.
* Only hexas that keep at least one triangle get a number: 1..N in row order
  (north → south), west → east within a row, no gaps.
"""

import math
from typing import NamedTuple

import numpy as np
import shapely
from shapely.geometry import MultiPolygon, Polygon

MIN_PIECE_M2 = 0.5


class Piece(NamedTuple):
	hexa_no: int
	t: int
	polygon_utm: Polygon
	full: bool


def _vertex(cx, cy, side, deg):
	rad = math.radians(deg)
	return (cx + side * math.cos(rad), cy + side * math.sin(rad))


def triangle(cx, cy, side, t):
	"""The full slot-`t` triangle of the hexa centred at (cx, cy)."""
	k = t - 1
	a = _vertex(cx, cy, side, 30 + 60 * k)
	b = _vertex(cx, cy, side, 30 + 60 * (k + 1))
	return Polygon([(cx, cy), a, b])


def _largest(geom):
	if geom is None or geom.is_empty:
		return None
	if isinstance(geom, Polygon):
		return geom
	polys = [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon) and not g.is_empty]
	if not polys and hasattr(geom, "geoms"):
		# A GeometryCollection may nest a MultiPolygon.
		for g in geom.geoms:
			if isinstance(g, MultiPolygon):
				polys.extend(g.geoms)
	if not polys:
		return None
	return max(polys, key=lambda p: p.area)


def cut(outline_utm, side_m: float) -> list[Piece]:
	"""Every kept triangle piece of the lattice over `outline_utm`, in hexa order."""
	if outline_utm is None or outline_utm.is_empty or side_m <= 0:
		return []
	minx, miny, maxx, maxy = outline_utm.bounds
	width = math.sqrt(3) * side_m
	dy = 1.5 * side_m
	n_rows = int(math.ceil((maxy - miny) / dy)) + 2
	n_cols = int(math.ceil((maxx - minx) / width)) + 2

	# Every candidate triangle at once: (row, col, t) and its geometry.
	keys = []
	tris = []
	for r in range(n_rows):
		cy = maxy - r * dy
		offset = width / 2 if r % 2 else 0.0
		for c in range(-1, n_cols):
			cx = minx + c * width + offset
			for t in range(1, 7):
				keys.append((r, c, t))
				tris.append(triangle(cx, cy, side_m, t))
	tris = np.array(tris, dtype=object)

	shapely.prepare(outline_utm)
	hits = shapely.intersects(outline_utm, tris)
	inside = shapely.contains(outline_utm, tris)

	kept = {}  # (r, c) -> list of (t, polygon, full)
	for i in np.nonzero(hits)[0]:
		r, c, t = keys[i]
		if inside[i]:
			poly, full = tris[i], True
		else:
			poly = _largest(shapely.intersection(tris[i], outline_utm))
			full = False
			if poly is None:
				continue
		if poly.area < MIN_PIECE_M2:
			continue
		kept.setdefault((r, c), []).append((t, poly, full))

	pieces = []
	for n, rc in enumerate(sorted(kept), start=1):
		for t, poly, full in sorted(kept[rc], key=lambda x: x[0]):
			pieces.append(Piece(n, t, poly, full))
	return pieces
