"""Pure geometry of the orchard grid generator (no database).

Run: bench --site mutara.local run-tests --app upande_scp \
        --module upande_scp.serverscripts.tests.test_orchard_grid
"""

import math
import unittest

from upande_scp.serverscripts.geo import generate_orchard_grid as G


def rect(w, h, rot=0.0):
	pts = [(0, 0), (w, 0), (w, h), (0, h)]
	c, s = math.cos(math.radians(rot)), math.sin(math.radians(rot))
	return [(x * c - y * s, x * s + y * c) for x, y in pts]


def dist(a, b):
	return math.hypot(a[0] - b[0], a[1] - b[1])


class TestOrchardGrid(unittest.TestCase):
	def test_longest_side_and_bearing(self):
		d, bearing, unit = G.longest_side(rect(300, 100))
		self.assertAlmostEqual(d, 300)
		self.assertAlmostEqual(bearing, 90, places=1)
		self.assertGreater(unit[0], 0)

	def test_direction_is_west_to_east(self):
		ring = list(reversed(rect(300, 100)))
		self.assertGreater(G.longest_side(ring)[2][0], 0)

	def test_noisy_outline_uses_min_rect(self):
		ring = [(i * 10.0, 0.4 * (i % 2)) for i in range(31)] + [(300, 100), (0, 100)]
		self.assertEqual(G.orientation(ring)[0], "min-rect-long-axis")
		self.assertAlmostEqual(G.orientation(ring)[2], 90, delta=1)

	def test_spacing_rows_and_inset(self):
		ring = rect(100, 60)
		rows = G.plan_grid(ring, (1, 0))
		self.assertEqual(len(rows), 10)  # 60 m / 6 m
		self.assertEqual(len(rows[0]), 25)  # 100 m / 4 m
		for r in rows:
			for a, b in zip(r, r[1:]):
				self.assertAlmostEqual(dist(a, b), 4.0, places=6)
		for a, b in zip(rows, rows[1:]):
			self.assertAlmostEqual(abs(a[0][1] - b[0][1]), 6.0, places=6)
		for r in rows:
			for p in r:
				self.assertTrue(G.point_in_polygon(p, ring))
				self.assertGreaterEqual(G.dist_to_boundary(p, ring), 2.0 - 1e-9)

	def test_numbering_row_one_nearest_longest_side_tree_one_west(self):
		ring = rect(100, 60)  # longest side y=0 (and y=60 ties; first edge wins)
		rows = G.plan_grid(ring, (1, 0))
		self.assertAlmostEqual(rows[0][0][1], 3.0)
		self.assertLess(rows[0][0][0], rows[0][1][0])
		for r in rows:  # same direction in every row
			self.assertLess(r[0][0], r[-1][0])
			self.assertAlmostEqual(r[0][0], rows[0][0][0])

	def test_rotated_block_keeps_distances(self):
		ring = rect(240, 90, rot=37)
		_, _, unit = G.orientation(ring)[1:]
		rows = G.plan_grid(ring, unit)
		self.assertGreater(len(rows), 10)
		for r in rows:
			for a, b in zip(r, r[1:]):
				self.assertAlmostEqual(dist(a, b), 4.0, places=6)
		self.assertAlmostEqual(
			abs((rows[1][0][0] - rows[0][0][0]) * -unit[1] + (rows[1][0][1] - rows[0][0][1]) * unit[0]), 6.0, delta=1e-6
		)

	def test_density_matches_area(self):
		rows = G.plan_grid(rect(400, 250), (1, 0))
		n = sum(len(r) for r in rows)
		self.assertAlmostEqual(n, 400 * 250 / 24, delta=400 * 250 / 24 * 0.06)

	def test_projection_round_trip_and_metres(self):
		a = G.unproject((100.0, 0.0), 36.67, 0.03)
		p = G.project([a], 36.67, 0.03)[0]
		self.assertAlmostEqual(p[0], 100.0, places=6)
		self.assertAlmostEqual(G.project([(36.67 + 0.001, 0.03)], 36.67, 0.03)[0][0], 111.32, delta=0.1)

	def test_names_and_outline_parse(self):
		self.assertEqual(G.tree_name("B - X", 2, 5), "B - X - Row 2 - Tree 5")
		raw = '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[1,1],[2,1],[2,2],[1,1]]]}}]}'
		self.assertEqual(G.outline_ring(raw), [(1, 1), (2, 1), (2, 2)])
		self.assertIsNone(G.outline_ring(None))

	def test_block_plan_lnglat(self):
		ring = [(36.0, 0.0), (36.003, 0.0), (36.003, 0.001), (36.0, 0.001)]
		plan = G.block_plan(ring)
		self.assertEqual(plan["method"], "longest-edge")
		self.assertAlmostEqual(plan["side_m"], 334, delta=2)
		r = plan["rows"][0]
		self.assertTrue(all(36.0 < p[0] < 36.003 for p in r))


class TestTreeIndex(unittest.TestCase):
	def test_nearest_and_max_distance(self):
		from upande_scp.serverscripts.geo.relink_avocado_entries import TreeIndex

		pts = [(36.0 + i * 0.00004, 0.0 + j * 0.00005) for i in range(10) for j in range(10)]
		idx = TreeIndex([f"T{n}" for n in range(100)], pts)
		name, d = idx.nearest(36.0 + 3.1 * 0.00004, 0.0 + 4.9 * 0.00005)
		self.assertEqual(name, "T35")  # i=3, j=5
		self.assertLess(d, 2.0)
		self.assertIsNone(idx.nearest(36.5, 0.5, max_m=60))
