"""Compact field geometry: triangles travel as Hexa centre + per-slot template, blocks as ordinary features.

Run: bench --site mutara.local run-tests --app upande_scp \
        --module upande_scp.serverscripts.tests.test_field_geo
"""

import json
import math
import unittest
import unittest.mock

import frappe

from upande_scp.serverscripts.geo import field_geo as G

Q = G.Q


def _vertex(cx, cy, k, r=0.0000450):
	ang = math.radians(30 + 60 * k)
	return (cx + r * math.cos(ang), cy + r * math.sin(ang))


def _ring_of(cx, cy, t):
	return [(cx, cy), _vertex(cx, cy, t - 1), _vertex(cx, cy, t), (cx, cy)]


def _tri(block, hexa, t, cx, cy, ring=None, row=None):
	ring = ring or _ring_of(cx, cy, t)
	return frappe._dict(
		name=f"{block} - Hexa {hexa} - Triad {t}", block=block, row=row or f"{block} - Hexa {hexa}", triad=t,
		geojson=json.dumps({"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [[list(p) for p in ring]]}}),
	)


def _hexa(block, n, cx, cy):
	return [_tri(block, n, t, cx, cy) for t in range(1, 7)]


class TestEncode(unittest.TestCase):
	def test_regular_triangles_encode_as_centre_plus_slot(self):
		rows = _hexa("B1 - MUT", 1, 36.6712345, 0.0412345) + _hexa("B1 - MUT", 2, 36.6713345, 0.0412345)
		enc = G.encode_triads(rows)
		blk = enc["blocks"]["B1 - MUT"]
		self.assertEqual(len(blk["reg"]), 12 * 4)  # hexa, t, x, y per triangle
		self.assertEqual(blk["irr"], [])
		self.assertEqual(sorted(blk["tpl"]), ["1", "2", "3", "4", "5", "6"])
		self.assertEqual(enc["q"], Q)
		for i in range(0, len(blk["reg"]), 4):
			hexa, t, x, y = blk["reg"][i : i + 4]
			back = G.decode_triad(x, y, blk["tpl"][str(t)])
			want = json.loads(rows[i // 4].geojson)["geometry"]["coordinates"][0]
			self.assertEqual(len(back), 4)
			for (bx, by), (wx, wy) in zip(back, want):
				self.assertLessEqual(abs(bx - wx) * Q, 1.5)
				self.assertLessEqual(abs(by - wy) * Q, 1.5)

	def test_edge_triangle_encoded_explicitly(self):
		rows = _hexa("B1 - MUT", 1, 36.67, 0.04)
		clipped = _tri("B1 - MUT", 2, 3, 0, 0, ring=[(36.7, 0.05), (36.70002, 0.05), (36.70002, 0.05003), (36.7, 0.05003), (36.7, 0.05)])
		blk = G.encode_triads(rows + [clipped])["blocks"]["B1 - MUT"]
		self.assertEqual(len(blk["reg"]), 6 * 4)
		self.assertEqual(len(blk["irr"]), 1)
		self.assertEqual(blk["irr"][0][:2], [2, 3])
		self.assertEqual(len(blk["irr"][0]), 3)  # name is rebuilt from hexa + t

	def test_old_non_hexa_rows_are_irregular_with_their_own_name(self):
		old = _tri("B1 - MUT", 1, 1, 36.67, 0.04, row="B1 - MUT - Row 4")
		old.name = "B1 - MUT - Row 4 - Triad 9"
		irr = G.encode_triads([old])["blocks"]["B1 - MUT"]["irr"]
		self.assertEqual(irr[0][0], None)
		self.assertEqual(irr[0][3], "B1 - MUT - Row 4 - Triad 9")

	def test_payload_has_no_rows(self):
		enc = G.encode_triads(_hexa("B1 - MUT", 1, 36.67, 0.04))
		self.assertNotIn("rows", enc)
		self.assertNotIn("hex", enc)
		self.assertFalse(hasattr(G, "_row_lines"))

	def test_payload_is_far_smaller_than_geojson(self):
		rows = [t for n in range(1, 300) for t in _hexa("B1 - MUT", n, 36.67 + n * 0.0002, 0.04)]
		enc = len(json.dumps(G.encode_triads(rows)))
		raw = sum(len(r.geojson) for r in rows)
		print(f"payload fixture: {raw} bytes GeoJSON -> {enc} bytes ({enc / raw:.1%})")
		self.assertLess(enc, raw * 0.2)


class TestVersion(unittest.TestCase):
	def test_unchanged_when_client_has_the_version(self):
		r = G.get_field_layers(farm="Mutara")
		again = G.get_field_layers(farm="Mutara", have=r["version"])
		self.assertEqual(again, {"version": r["version"], "unchanged": True})

	def test_version_depends_on_format_tag(self):
		before = G._version("Mutara")
		with unittest.mock.patch.object(G, "FORMAT_TAG", "tri-next"):
			self.assertNotEqual(G._version("Mutara"), before)
		self.assertTrue(G.K_PAYLOAD.endswith("_v2"))
