"""The Hexa → Triad grid of a block as its lattice, for an instanced (GPU) draw of the whole farm.

`hexa_grid.cut` lays a regular lattice over a block: in the block's UTM zone, origin O at the
outline's north-west corner (minx, maxy), pointy-top hexas of circumradius `side`, rows of
height 1.5·side north → south, odd rows shifted east by half a width (√3·side), slot t =
[centre, V(30°+60°k), V(30°+60°(k+1))], hexas numbered 1..N in (row, col) order. So a full
triangle is three small integers (row, col, slot) once O, side and the UTM zone are known, and
only the clipped edge pieces need their own coordinates.

Per block this sends:

* ``o``: O in UTM metres, ``side``, ``epsg``; ``aff``: the affine map from UTM metres relative to
  O to Web-Mercator metres (EPSG:3857), least-squares over the block (residual well under a mm
  over a few hundred metres), so the browser projects without a projection library;
* ``h``: per numbered hexa, in hexa order, ``[row delta, col, kept | full << 6]`` flattened
  (kept / full: one bit per slot, bit t-1); hexa_no is the position (1..N) unless ``no`` is given;
* ``e``: clipped pieces ``[hexa index, t, ring]`` with the ring in centimetres relative to the
  hexa centre, in UTM (flat x, y, ... without the closing point);
* ``x``: triads that do not fit the lattice (old names, odd data): ``[name, ring]`` with the ring
  in 1e-7 degrees, delta-encoded (the old irregular encoding). Empty on a regenerated block.

The stored Triad polygons stay the truth (scouting entries point at them by name): the lattice
is read back from them, with O taken from the Warehouse outline exactly as `regenerate_hexa_grid`
cut it when that fits the stored triangles (else from the triangles themselves, ~1 cm).
"""

import json
import math
import re

import frappe
import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import Polygon
from shapely.ops import unary_union

from upande_scp.serverscripts.common.cache_utils import TTL_LONG
from upande_scp.serverscripts.geo.field_geo import _version
from upande_scp.serverscripts.mobile.geo_utils import get_dynamic_utm_epsg

K_LATTICE = "scp:field_lattice_v1"
FORMAT = "lat1"
MAX_BLOCKS_PER_CALL = 80
FIT_TOL_M = 0.03  # a stored full triangle may sit this far off the lattice (1e-7° rounding)
Q = 10_000_000
_HEXA_RE = re.compile(r" - Hexa (\d+)$")
_NAME_RE = re.compile(r"^(?P<b>.*) - Hexa (?P<h>\d+) - Triad (?P<t>\d+)$")
WEB_R = 6378137.0


def _ring(geojson):
	g = json.loads(geojson) if isinstance(geojson, str) else geojson
	if g.get("type") == "FeatureCollection":
		g = (g.get("features") or [{}])[0] or {}
	if g.get("type") == "Feature":
		g = g.get("geometry") or {}
	coords = g.get("coordinates") or []
	if g.get("type") == "MultiPolygon":
		coords = coords[0] if coords else []
	return [(p[0], p[1]) for p in coords[0]] if coords else []


def _outline_origin(block, fwd):
	"""(minx, maxy) of the outline exactly as regenerate_hexa_grid cut it, or None."""
	from upande_scp.serverscripts.geo.regenerate_hexa_grid import _block_outline

	geo = _block_outline(block)
	if geo is None:
		return None
	polys = shapely.make_valid(shapely.transform(geo, lambda xy: np.column_stack(fwd.transform(xy[:, 0], xy[:, 1]))))
	outline = unary_union(polys).buffer(0.05).buffer(-0.05)
	if outline.is_empty:
		return None
	minx, _, _, maxy = outline.bounds
	return minx, maxy


def _affine(o, epsg, bbox):
	"""UTM metres relative to O -> EPSG:3857 metres, least squares on a 5x5 grid over bbox."""
	to_web = Transformer.from_crs(epsg, "EPSG:3857", always_xy=True)
	xs = np.linspace(bbox[0], bbox[2], 5)
	ys = np.linspace(bbox[1], bbox[3], 5)
	gx, gy = np.meshgrid(xs, ys)
	gx, gy = gx.ravel(), gy.ravel()
	wx, wy = to_web.transform(gx, gy)
	a = np.column_stack([gx - o[0], gy - o[1], np.ones_like(gx)])
	cx, *_ = np.linalg.lstsq(a, wx, rcond=None)
	cy, *_ = np.linalg.lstsq(a, wy, rcond=None)
	resid = max(np.abs(a @ cx - wx).max(), np.abs(a @ cy - wy).max())
	return [float(v) for v in (*cx, *cy)], float(resid)


def _corner(cx, cy, side, deg):
	r = math.radians(deg)
	return cx + side * math.cos(r), cy + side * math.sin(r)


def _tri_corners(cx, cy, side, t):
	k = t - 1
	return [(cx, cy), _corner(cx, cy, side, 30 + 60 * k), _corner(cx, cy, side, 30 + 60 * (k + 1))]


def _in_tri(p, tri, eps=0.02):
	(x1, y1), (x2, y2), (x3, y3) = tri
	d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3)
	a = ((y2 - y3) * (p[0] - x3) + (x3 - x2) * (p[1] - y3)) / d
	b = ((y3 - y1) * (p[0] - x3) + (x1 - x3) * (p[1] - y3)) / d
	return a >= -eps and b >= -eps and 1 - a - b >= -eps


def _delta_q(ring):
	out, px, py = [], 0, 0
	for x, y in ring:
		qx, qy = round(x * Q), round(y * Q)
		out.extend((qx - px, qy - py))
		px, py = qx, qy
	return out


def encode_block(block, rows):
	"""``rows``: dicts with name, row, triad, geojson. Returns the block's lattice dict."""
	items = []
	for r in rows:
		ring = _ring(r.geojson) if r.geojson else []
		if len(ring) >= 4:
			items.append((r, ring))
	if not items:
		return {"h": [], "e": [], "x": []}
	lng0, lat0 = items[0][1][0]
	epsg = get_dynamic_utm_epsg(lat0, lng0)
	fwd = Transformer.from_crs("EPSG:4326", epsg, always_xy=True)
	flat = np.array([p for _, ring in items for p in ring], dtype=float)
	ux, uy = fwd.transform(flat[:, 0], flat[:, 1])
	utm, k = [], 0
	for _, ring in items:
		utm.append(list(zip(ux[k : k + len(ring)], uy[k : k + len(ring)])))
		k += len(ring)

	# Which stored triangles are full lattice triangles: [C, V(a), V(b), C] around their first vertex.
	def full_side(t, pts):
		if len(pts) != 4 or t not in range(1, 7):
			return None
		(cx, cy), a = pts[0], pts[1]
		s = math.hypot(a[0] - cx, a[1] - cy)
		want = _tri_corners(cx, cy, s, t)
		ok = all(math.hypot(p[0] - q[0], p[1] - q[1]) <= FIT_TOL_M for p, q in zip(pts[:3], want))
		return s if ok and abs(pts[3][0] - cx) <= FIT_TOL_M and abs(pts[3][1] - cy) <= FIT_TOL_M else None

	parsed = []  # (hexa_no, t, utm ring, full_side) for lattice-named triads; others go to x
	extra = []
	for (r, ring), pts in zip(items, utm):
		m = _NAME_RE.match(r.name or "")
		hm = _HEXA_RE.search(r.row or "")
		t = r.triad if isinstance(r.triad, int) else None
		if not m or not hm or m.group("b") != block or int(m.group("h")) != int(hm.group(1)) or int(m.group("t")) != t:
			extra.append([r.name, _delta_q(ring)])
			continue
		parsed.append((int(hm.group(1)), t, pts, full_side(t, pts)))
	sides = sorted(s for *_, s in parsed if s)
	if not sides:
		return {"h": [], "e": [], "x": extra + [[f"{block} - Hexa {h} - Triad {t}", _delta_q(_back(epsg, pts))] for h, t, pts, _ in parsed]}
	side = round(sides[len(sides) // 2], 2)  # the cut side (5 m); the stored rounding is far below a cm
	w, dy = math.sqrt(3) * side, 1.5 * side
	centres = {}
	for h, t, pts, s in parsed:
		if s and h not in centres:
			centres[h] = pts[0]

	# Lattice frame: UTM = o + G @ ideal, ideal = ((c + (r % 2) / 2) * w, -r * dy). Start from the
	# outline's NW corner (how regenerate_hexa_grid cut it) or a stored centre, then fit o and G to
	# every stored full-triangle centre: a block cut in a slightly different frame (some blocks
	# drift ~10 cm over their length against the outline) is still matched to the stored data.
	o0 = _outline_origin(block, fwd)
	near = lambda o: all(  # noqa: E731
		abs((o[1] - cy) / dy - round((o[1] - cy) / dy)) < 0.1 for cx, cy in list(centres.values())[:50]
	)
	if not o0 or not near(o0):
		o0 = next(iter(centres.values()))
	keys, cx_, cy_ = [], [], []
	for h, (cx, cy) in centres.items():
		r = round((o0[1] - cy) / dy)
		c = round((cx - o0[0] - (r % 2) * w / 2) / w)
		keys.append((h, r, c))
		cx_.append(cx)
		cy_.append(cy)
	A = np.array([[1.0, (c + (r % 2) / 2) * w, -r * dy] for _, r, c in keys])
	px_, *_ = np.linalg.lstsq(A, np.array(cx_), rcond=None)
	py_, *_ = np.linalg.lstsq(A, np.array(cy_), rcond=None)
	o = (float(px_[0]), float(py_[0]))
	G = np.array([[px_[1], px_[2]], [py_[1], py_[2]]])
	Ginv = np.linalg.inv(G)
	fit_resid = float(max(np.abs(A @ px_ - cx_).max(), np.abs(A @ py_ - cy_).max()))
	# When the outline's corner and the nominal side already put every stored centre on the lattice
	# (within the stored rounding), use exactly that: it is hexa_grid.cut's own frame.
	exact = False
	o_cut = _outline_origin(block, fwd)
	if o_cut:
		Ac = A.copy()
		dev = max(np.abs(o_cut[0] + Ac[:, 1] - cx_).max(), np.abs(o_cut[1] + Ac[:, 2] - cy_).max())
		if dev <= 0.02:
			o, G, Ginv, exact, fit_resid = o_cut, np.eye(2), np.eye(2), True, float(dev)

	def ideal(x, y):
		v = Ginv @ np.array([x - o[0], y - o[1]])
		return float(v[0]), float(v[1])

	def ideal_centre(r, c):
		return (c + (r % 2) / 2) * w, -r * dy

	hexas = {h: [r, c, 0, 0] for h, r, c in keys}
	clipped = []
	for h, t, pts, s in parsed:
		if h not in hexas:
			# Only clipped pieces: the hexa whose slot-t triangle holds the piece's centroid.
			px, py = ideal(sum(p[0] for p in pts[:-1]) / (len(pts) - 1), sum(p[1] for p in pts[:-1]) / (len(pts) - 1))
			r0 = round(-py / dy)
			found = None
			for r in (r0 - 1, r0, r0 + 1):
				c0 = round(px / w - (r % 2) / 2)
				for c in (c0 - 1, c0, c0 + 1):
					if _in_tri((px, py), _tri_corners(*ideal_centre(r, c), side, t)):
						found = (r, c)
			if not found:
				extra.append([f"{block} - Hexa {h} - Triad {t}", _delta_q(_back(epsg, pts))])
				continue
			hexas[h] = [found[0], found[1], 0, 0]
		hexas[h][2] |= 1 << (t - 1)
		if s:
			hexas[h][3] |= 1 << (t - 1)
		else:
			clipped.append((h, t, pts))

	order = sorted(hexas)
	out_h, prev_r = [], 0
	for h in order:
		r, c, kept, full = hexas[h]
		out_h.extend((r - prev_r, c, kept | (full << 6)))
		prev_r = r
	idx = {h: i for i, h in enumerate(order)}
	lattice_order = sorted(order, key=lambda h: (hexas[h][0], hexas[h][1]))
	res = {
		"epsg": int(epsg.split(":")[1]),
		"o": [round(o[0], 4), round(o[1], 4)],
		"side": side,
		"exact": bool(exact),
		"h": out_h,
		"e": [],
		"x": extra,
	}
	if order != list(range(1, len(order) + 1)) or lattice_order != order:
		res["no"] = order
	for h, t, pts in clipped:
		icx, icy = ideal_centre(hexas[h][0], hexas[h][1])
		ring = []
		for x, y in pts[:-1]:
			ix, iy = ideal(x, y)
			ring.extend((round((ix - icx) * 100), round((iy - icy) * 100)))
		res["e"].append([idx[h], t, ring])
	xs = [p[0] for _, _, pts, _ in parsed for p in pts]
	ys = [p[1] for _, _, pts, _ in parsed for p in pts]
	aff, aff_resid = _affine(o, epsg, (min(xs), min(ys), max(xs), max(ys)))
	# Fold the lattice frame in: web = Aweb @ (G @ ideal) + c.
	Aw = np.array([[aff[0], aff[1]], [aff[3], aff[4]]]) @ G
	res["aff"] = [float(Aw[0, 0]), float(Aw[0, 1]), aff[2], float(Aw[1, 0]), float(Aw[1, 1]), aff[5]]
	res["aff_resid_m"] = aff_resid
	res["fit_resid_m"] = fit_resid
	return res


def _back(epsg, pts):
	inv = Transformer.from_crs(epsg, "EPSG:4326", always_xy=True)
	x, y = inv.transform([p[0] for p in pts], [p[1] for p in pts])
	return list(zip(x, y))


# --------------------------------------------------------------------------- decoding (the browser's maths)


def _web_to_lnglat(x, y):
	return math.degrees(x / WEB_R), math.degrees(2 * math.atan(math.exp(y / WEB_R)) - math.pi / 2)


def decode_block(enc):
	"""{(hexa_no, t): [(lng, lat), ...]} as the browser rebuilds it (open rings). Mirrors
	frontend/src/lib/field-lattice.ts; the exact-match test runs both on the same fixture."""
	out = {}
	if not enc.get("h"):
		return out
	o, side, aff = enc["o"], enc["side"], enc["aff"]
	w, dy = math.sqrt(3) * side, 1.5 * side

	def lnglat(x, y):  # UTM relative to O
		return _web_to_lnglat(aff[0] * x + aff[1] * y + aff[2], aff[3] * x + aff[4] * y + aff[5])

	h, r, cells = enc["h"], 0, []
	for i in range(0, len(h), 3):
		r += h[i]
		c, bits = h[i + 1], h[i + 2]
		cx, cy = c * w + (r % 2) * w / 2, -r * dy  # relative to O
		cells.append((cx, cy, bits & 63, bits >> 6))
	nos = enc.get("no") or list(range(1, len(cells) + 1))
	for no, (cx, cy, kept, full) in zip(nos, cells):
		for t in range(1, 7):
			if full >> (t - 1) & 1:
				out[(no, t)] = [lnglat(x, y) for x, y in _tri_corners(cx, cy, side, t)]
	for i, t, ring in enc["e"]:
		cx, cy, _, _ = cells[i]
		out[(nos[i], t)] = [lnglat(cx + ring[j] / 100, cy + ring[j + 1] / 100) for j in range(0, len(ring), 2)]
	return out


# --------------------------------------------------------------------------- endpoint


def _encode_blocks(names):
	rows = frappe.db.sql(
		"select name, block, `row`, triad, geojson from `tabTriad` where block in %(b)s", {"b": tuple(names)}, as_dict=True,
	)
	by = {}
	for r in rows:
		by.setdefault(r.block, []).append(r)
	out = {}
	for b in names:
		enc = encode_block(b, by.get(b, []))
		enc.pop("aff_resid_m", None)
		enc.pop("fit_resid_m", None)
		out[b] = enc
	return out


@frappe.whitelist()
def get_field_lattice(blocks, version=None, farm=None):
	"""The lattice encoding of the named blocks (see module doc). ``version`` is the one
	``field_geo.get_field_index`` gave; a stale one is answered ``{stale: true, version}``."""
	if isinstance(blocks, str):
		blocks = frappe.parse_json(blocks)
	names = [str(b) for b in (blocks or []) if b][:MAX_BLOCKS_PER_CALL]
	farm = (farm or "").strip()
	cache = frappe.cache()
	out, missing = {}, []
	for b in names:
		hit = cache.get_value(f"{K_LATTICE}:{FORMAT}:{version}:{b}") if version else None
		if hit is None:
			missing.append(b)
		else:
			out[b] = hit
	if missing:
		current = _version(farm)
		if version and version != current:
			return {"stale": True, "version": current}
		version = current
		for b, enc in _encode_blocks(missing).items():
			out[b] = enc
			cache.set_value(f"{K_LATTICE}:{FORMAT}:{version}:{b}", enc, expires_in_sec=TTL_LONG)
	return {"version": version, "format": FORMAT, "blocks": out}


def warm_field_lattice(farm=None):
	"""Encode and cache every block's lattice for the farm's current version (all farms when blank),
	so the first map load after a regenerate or a cache expiry reads Redis instead of encoding
	(about half a minute for Mutara). Run it with
	``bench --site <site> execute upande_scp.serverscripts.geo.field_lattice.warm_field_lattice``."""
	from upande_scp.serverscripts.geo.field_geo import _counts

	farm = (farm or "").strip()
	version = _version(farm)
	cache = frappe.cache()
	todo = [b for b in _counts(farm) if cache.get_value(f"{K_LATTICE}:{FORMAT}:{version}:{b}") is None]
	for i in range(0, len(todo), 8):
		for b, enc in _encode_blocks(todo[i : i + 8]).items():
			cache.set_value(f"{K_LATTICE}:{FORMAT}:{version}:{b}", enc, expires_in_sec=TTL_LONG)
	return {"version": version, "warmed": len(todo)}
