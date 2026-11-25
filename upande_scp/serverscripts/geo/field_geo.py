"""Compact, cached geometry for the block-grown crops' maps (blocks and triangles).

Mutara is surveyed into Hexas (5 m regular hexagons) of six Triads, one per triangle. Sent as
GeoJSON that is megabytes and a second of parse before the map shows anything. This is the
avocado-tree trick (the browser rebuilds what lies between a few numbers) applied to triangles:

* a full triangle is ``[centre, a, b, centre]``: the Hexa's centre plus one shared 3-corner
  template per slot (1..6), so it travels as ``[hexa, t, x, y]`` in integer 1e-7 degree units;
* the clipped / irregular pieces on field edges carry their own delta-encoded ring;
* a block is an ordinary (small) feature;
* the whole payload is cached in Redis under a version derived from the data (row counts and
  newest ``modified``), and the browser sends the version it holds: an unchanged answer is
  ~40 bytes and the browser reuses its own copy (IndexedDB), so a repeat visit costs no parse.

The browser hands the rebuilt triangles to MapLibre as one GeoJSON source: tiling and parsing
happen in MapLibre's worker, only triangles in view are drawn, and the triangle layers carry a
minzoom, so zoomed out only the always-on block boundaries are painted.
"""

import hashlib
import json

import frappe

from upande_scp.serverscripts.common.cache_utils import TTL_LONG

Q = 10_000_000  # integer units per degree (1.1 cm)
K_GEO_STAMP = "scp:field_geo_stamp_v1"
K_PAYLOAD = "scp:field_geo_payload_v2"
FORMAT_TAG = "tri1"  # bump when the payload shape changes: it is part of the version hash
_NAME = "{block} - Hexa {hexa} - Triad {t}"
_TOL = 1  # template tolerance, in 1e-7 degree units (one quantum)


def bump_geo_version() -> None:
	frappe.cache().set_value(K_GEO_STAMP, frappe.generate_hash(length=8))


def _ring(geojson):
	g = json.loads(geojson)
	if g.get("type") == "FeatureCollection":
		g = (g.get("features") or [{}])[0]
	coords = (g.get("geometry") or {}).get("coordinates") or []
	return [(p[0], p[1]) for p in coords[0]] if coords else []


def _hexa_no(r):
	"""The Hexa number from the Triad's row ("{block} - Hexa {n}"), or None for old/odd data."""
	tail = str(r.row or "").rsplit(" - Hexa ", 1)
	return int(tail[1]) if len(tail) == 2 and tail[1].isdigit() else None


def _tri_offsets(ring_q):
	"""A full triangle ``[centre, a, b, centre]`` as offsets of its corners from the centre."""
	if len(ring_q) != 4 or ring_q[0] != ring_q[3]:
		return None
	cx, cy = ring_q[0]
	return tuple((x - cx, y - cy) for x, y in ring_q[:3])


def _regular_name(r, hexa):
	return hexa is not None and r.triad in range(1, 7) and r.name == _NAME.format(block=r.block, hexa=hexa, t=r.triad)


def _template(items):
	"""Per slot 1..6, the most common corner offsets among full triangles of the block."""
	counts: dict = {}
	for r, hexa, rq in items:
		off = _tri_offsets(rq)
		if off and _regular_name(r, hexa):
			c = counts.setdefault(r.triad, {})
			c[off] = c.get(off, 0) + 1
	return {str(t): [list(p) for p in max(c, key=c.get)] for t, c in sorted(counts.items())}


def decode_triad(x, y, tpl_t):
	"""The closed ring (degrees) of a regular triangle whose Hexa is centred at integer (x, y)."""
	ring = [((x + dx) / Q, (y + dy) / Q) for dx, dy in tpl_t]
	ring.append(ring[0])
	return ring


def _matches(rq, tpl_t):
	off = _tri_offsets(rq)
	if off is None or not tpl_t:
		return False
	return all(abs(a - dx) <= _TOL and abs(b - dy) <= _TOL for (a, b), (dx, dy) in zip(off, tpl_t))


def _delta(ring_q):
	out = []
	px = py = 0
	for x, y in ring_q:
		out.extend((x - px, y - py))
		px, py = x, y
	return out


def encode_triads(rows):
	"""``rows``: dicts/_dicts with name, block, row (Hexa bed name), triad (1..6), geojson."""
	by_block: dict = {}
	for r in rows:
		ring = _ring(r.geojson) if r.geojson else []
		if len(ring) < 4:
			continue
		by_block.setdefault(r.block, []).append((r, _hexa_no(r), [(round(x * Q), round(y * Q)) for x, y in ring]))
	blocks: dict = {}
	for block in sorted(by_block, key=lambda b: b or ""):
		items = by_block[block]
		tpl = _template(items)
		b = blocks[block] = {"tpl": tpl, "reg": [], "irr": []}
		for r, hexa, rq in items:
			if _regular_name(r, hexa) and _matches(rq, tpl.get(str(r.triad))):
				b["reg"].extend((hexa, r.triad, rq[0][0], rq[0][1]))
			else:
				t = r.triad if isinstance(r.triad, int) else None
				entry = [hexa, t, _delta(rq)]
				if not _regular_name(r, hexa):
					entry.append(r.name)  # its own name: it cannot be rebuilt from hexa + t
				b["irr"].append(entry)
	return {"q": Q, "blocks": blocks}


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
	return hashlib.sha1(f"{FORMAT_TAG}|{t}|{w}|{stamp}".encode()).hexdigest()[:16]


def _build(farm):
	rows = frappe.db.sql(
		"select name, block, `row`, triad, geojson from `tabTriad` where (%(f)s = '' or farm = %(f)s)", {"f": farm or ""}, as_dict=True,
	)
	return {"blocks": _blocks_fc(farm), "tri": encode_triads(rows)}


@frappe.whitelist()
def get_field_layers(farm=None, have=None):
	"""Blocks (always) and triangles for a farm, versioned. ``have`` = the version the
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
