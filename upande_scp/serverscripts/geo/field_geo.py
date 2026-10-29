"""Compact, cached geometry for the block-grown crops' maps (blocks, rows, hexagons).

Mutara is surveyed to ~24,000 Triads (3 m hexagons). Sent as GeoJSON that is ~9 MB and a
second of parse before the map shows anything. This is the avocado-tree trick (Kaitet sends a
tree row as two endpoints and the browser rebuilds the trees between them) applied to hexagons:

* a regular hexagon is its centre plus one shared 6-vertex template, so it travels as
  ``[row, number, x, y]`` in integer 1e-7 degree units — about 20 bytes instead of ~400;
* the few clipped or irregular hexagons (field edges) carry their own delta-encoded ring;
* a row is two endpoints; a block is an ordinary (small) feature;
* the whole payload is cached in Redis under a version derived from the data (row counts and
  newest ``modified``), and the browser sends the version it holds: an unchanged answer is
  ~40 bytes and the browser reuses its own copy (IndexedDB), so a repeat visit costs no parse.

The browser hands the rebuilt hexagons to MapLibre as one GeoJSON source: tiling and parsing
happen in MapLibre's worker, only hexagons in view are drawn, and the hexagon layers carry a
minzoom, so zoomed out only the always-on block boundaries are painted.
"""

import hashlib
import json

import frappe

from upande_scp.serverscripts.common.cache_utils import TTL_LONG

Q = 10_000_000  # integer units per degree (1.1 cm)
K_GEO_STAMP = "scp:field_geo_stamp_v1"
K_PAYLOAD = "scp:field_geo_payload_v1"
_NAME = "{block} - Row {row} - Triad {num}"
_TOL = 2  # template tolerance, in 1e-7 degree units


def bump_geo_version() -> None:
	frappe.cache().set_value(K_GEO_STAMP, frappe.generate_hash(length=8))


def _ring(geojson):
	g = json.loads(geojson)
	if g.get("type") == "FeatureCollection":
		g = (g.get("features") or [{}])[0]
	coords = (g.get("geometry") or {}).get("coordinates") or []
	return [(p[0], p[1]) for p in coords[0]] if coords else []


def _centre(ring_q):
	xs = [p[0] for p in ring_q]
	ys = [p[1] for p in ring_q]
	return (min(xs) + max(xs)) // 2, (min(ys) + max(ys)) // 2


def _template(rings_q):
	"""Offsets of a regular hexagon's six corners from its centre: the most common 7-point ring."""
	counts: dict = {}
	for r in rings_q:
		if len(r) != 7:
			continue
		cx, cy = _centre(r)
		key = tuple((x - cx, y - cy) for x, y in r[:6])
		counts[key] = counts.get(key, 0) + 1
	if not counts:
		return []
	best = max(counts, key=counts.get)
	return [list(p) for p in best]


def decode_hex(x, y, tpl):
	"""The closed ring (degrees) of a regular hexagon centred at integer (x, y)."""
	ring = [((x + dx) / Q, (y + dy) / Q) for dx, dy in tpl]
	ring.append(ring[0])
	return ring


def _matches(ring_q, tpl):
	if len(ring_q) != 7 or ring_q[0] != ring_q[-1]:
		return None
	cx, cy = _centre(ring_q)
	for (x, y), (dx, dy) in zip(ring_q[:6], tpl):
		if abs(x - cx - dx) > _TOL or abs(y - cy - dy) > _TOL:
			return None
	return cx, cy


def _delta(ring_q):
	out = []
	px = py = 0
	for x, y in ring_q:
		out.extend((x - px, y - py))
		px, py = x, y
	return out


def encode_hexes(rows):
	"""``rows``: dicts/_dicts with name, block, row (Bed name), triad (number), geojson."""
	parsed = []
	for r in rows:
		ring = _ring(r.geojson) if r.geojson else []
		if len(ring) < 4:
			continue
		parsed.append((r, [(round(x * Q), round(y * Q)) for x, y in ring]))
	tpl = _template([p[1] for p in parsed])
	blocks: dict = {}
	for r, rq in parsed:
		b = blocks.setdefault(r.block, {"b": r.block, "reg": [], "irr": []})
		row_no = _row_no(r)
		hit = _matches(rq, tpl) if tpl else None
		if hit and row_no is not None and r.name == _NAME.format(block=r.block, row=row_no, num=r.triad):
			b["reg"].extend((row_no, r.triad, hit[0], hit[1]))
		else:
			b["irr"].append([r.name, row_no, r.triad, _delta(rq)])
	return {"q": Q, "tpl": tpl, "blocks": [blocks[k] for k in sorted(blocks)]}


def _row_no(r):
	tail = str(r.row or "").rsplit(" - Row ", 1)[-1]
	return int(tail) if tail.isdigit() else None


def _row_lines(rows):
	"""One line per row: the first and last hexagon centres, from the already-parsed rows."""
	by: dict = {}
	for r in rows:
		ring = _ring(r.geojson) if r.geojson else []
		if len(ring) < 4:
			continue
		xs = [p[0] for p in ring]
		ys = [p[1] for p in ring]
		by.setdefault((r.block, r.row), []).append((r.triad, (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2))
	out = []
	for (block, row), pts in sorted(by.items()):
		pts.sort()
		a, z = pts[0], pts[-1]
		out.append(
			{"b": block, "r": _row_no(frappe._dict(row=row)), "n": len(pts),
			 "a": [round(a[1] * Q), round(a[2] * Q)], "z": [round(z[1] * Q), round(z[2] * Q)]}
		)
	return out


def _blocks_fc(farm=None):
	from upande_scp.serverscripts.geo.geo_builders import build_blocks_geojson

	fc = build_blocks_geojson()
	if farm:
		fc = {"type": "FeatureCollection", "features": [f for f in fc["features"] if f["properties"].get("farm") == farm]}
	return fc


def _version(farm):
	t = frappe.db.sql("select count(*), max(modified) from `tabTriad` where (%(f)s = '' or farm = %(f)s)", {"f": farm or ""})[0]
	w = frappe.db.sql(
		"select count(*), max(modified) from `tabWarehouse` where custom_raw_geojson is not null and custom_raw_geojson != ''"
		" and (%(f)s = '' or custom_farm = %(f)s)", {"f": farm or ""},
	)[0]
	stamp = frappe.cache().get_value(K_GEO_STAMP) or ""
	return hashlib.sha1(f"{t}|{w}|{stamp}".encode()).hexdigest()[:16]


def _build(farm):
	rows = frappe.db.sql(
		"select name, block, `row`, triad, geojson from `tabTriad` where (%(f)s = '' or farm = %(f)s)", {"f": farm or ""}, as_dict=True,
	)
	return {"blocks": _blocks_fc(farm), "rows": _row_lines(rows), "hex": encode_hexes(rows)}


@frappe.whitelist()
def get_field_layers(farm=None, have=None):
	"""Blocks (always), rows and hexagons for a farm, versioned. ``have`` = the version the
	browser already holds: when it is current the answer is just ``{version, unchanged}``."""
	farm = (farm or "").strip()
	version = _version(farm)
	if have and have == version:
		return {"version": version, "unchanged": True}
	cache = frappe.cache()
	key = f"{K_PAYLOAD}:{farm}:{version}"
	payload = cache.get_value(key)
	if payload is None:
		payload = _build(farm)
		cache.set_value(key, payload, expires_in_sec=TTL_LONG)
	return {"version": version, **payload}
