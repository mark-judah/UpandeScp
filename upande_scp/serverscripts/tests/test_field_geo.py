"""Compact field geometry: hexagons travel as centre + shared template, blocks as ordinary features.

Run: bench --site mutara.local run-tests --app upande_scp \
        --module upande_scp.serverscripts.tests.test_field_geo
"""

import json
import unittest

import frappe

from upande_scp.serverscripts.geo import field_geo as G

Q = G.Q


def _hex(cx, cy, r=0.0000233):
	h = r * 0.866
	pts = [(cx - r, cy), (cx - r / 2, cy - h), (cx + r / 2, cy - h), (cx + r, cy), (cx + r / 2, cy + h), (cx - r / 2, cy + h)]
	pts.append(pts[0])
	return pts


def _row(block, row, num, cx, cy, ring=None):
	ring = ring or _hex(cx, cy)
	return frappe._dict(
		name=f"{block} - Row {row} - Triad {num}", block=block, row=f"{block} - Row {row}", triad=num,
		geojson=json.dumps({"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [[list(p) for p in ring]]}}),
	)


class TestEncode(unittest.TestCase):
	def test_regular_hexes_are_centre_only_and_irregular_ones_explicit(self):
		reg = [_row("B1 - MUT", 1, i, 36.67 + i * 0.0001, 0.04) for i in range(1, 6)]
		edge_ring = [(36.7, 0.05), (36.70002, 0.05), (36.70002, 0.05003), (36.7, 0.05)]
		edge = _row("B1 - MUT", 2, 1, 0, 0, ring=edge_ring)
		enc = G.encode_hexes(reg + [edge])
		blk = enc["blocks"][0]
		self.assertEqual(len(blk["reg"]), 5 * 4)  # row, number, x, y per regular hex
		self.assertEqual(len(blk["irr"]), 1)
		self.assertEqual(enc["q"], Q)

	def test_round_trip_matches_to_a_centimetre(self):
		rows = [_row("B1 - MUT", 3, 7, 36.6712345, 0.0412345)]
		blk = G.encode_hexes(rows)["blocks"][0]
		back = G.decode_hex(blk["reg"][2], blk["reg"][3], G.encode_hexes(rows)["tpl"])
		want = json.loads(rows[0].geojson)["geometry"]["coordinates"][0]
		for (bx, by), (wx, wy) in zip(back, want):
			self.assertAlmostEqual(bx, wx, places=6)
			self.assertAlmostEqual(by, wy, places=6)

	def test_names_that_do_not_follow_the_pattern_are_carried_explicitly(self):
		odd = _row("B1 - MUT", 1, 1, 36.67, 0.04)
		odd.name = "something else"
		blk = G.encode_hexes([odd])["blocks"][0]
		self.assertEqual(len(blk["irr"]), 1)

	def test_payload_is_far_smaller_than_geojson(self):
		rows = [_row("B1 - MUT", r, i, 36.67 + i * 0.00005, 0.04 + r * 0.00005) for r in range(1, 30) for i in range(1, 40)]
		enc = json.dumps(G.encode_hexes(rows))
		raw = sum(len(r.geojson) for r in rows)
		self.assertLess(len(enc), raw * 0.2)


class TestVersion(unittest.TestCase):
	def test_unchanged_when_client_has_the_version(self):
		r = G.get_field_layers(farm="Mutara")
		again = G.get_field_layers(farm="Mutara", have=r["version"])
		self.assertEqual(again, {"version": r["version"], "unchanged": True})
