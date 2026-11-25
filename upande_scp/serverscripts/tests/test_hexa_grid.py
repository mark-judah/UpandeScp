"""The hexa lattice cut: equilateral slots at the standard side, numbered NW → SE.

Run: bench --site <site> run-tests --module upande_scp.serverscripts.tests.test_hexa_grid
"""

import math
import unittest

from shapely.geometry import Point, box

from upande_scp.serverscripts.geo.hexa_grid import cut


def _sides(poly):
	c = list(poly.exterior.coords)
	return [math.dist(c[i], c[i + 1]) for i in range(len(c) - 1)]


def _bearing(centre, point):
	return math.degrees(math.atan2(point[1] - centre[1], point[0] - centre[0])) % 360


class TestHexaGrid(unittest.TestCase):
	def test_square_100m_at_5m(self):
		square = box(0, 0, 100, 100)
		pieces = cut(square, 5.0)
		full = [p for p in pieces if p.full]
		self.assertTrue(full)
		for p in full:
			coords = list(p.polygon_utm.exterior.coords)
			self.assertEqual(len(coords), 4)
			for s in _sides(p.polygon_utm):
				self.assertAlmostEqual(s, 5.0, delta=0.01)
		total = sum(p.polygon_utm.area for p in pieces)
		self.assertLessEqual(abs(total - 10_000) / 10_000, 0.01)

		numbers = sorted({p.hexa_no for p in pieces})
		self.assertEqual(numbers, list(range(1, len(numbers) + 1)))

		# Hexa 1 is the north-west-most: it owns the piece nearest the NW corner.
		nw = min(pieces, key=lambda p: p.polygon_utm.distance(Point(0, 100)) + p.polygon_utm.centroid.distance(Point(0, 100)))
		self.assertEqual(nw.hexa_no, 1)
		# Row order: hexa numbers never go back north.
		inner = sorted({p.hexa_no for p in pieces if p.full})
		ys = [_hexa_centre(pieces, n)[1] for n in inner]
		self.assertTrue(all(b <= a + 1e-6 for a, b in zip(ys, ys[1:])))

	def test_slot_order(self):
		pieces = cut(box(0, 0, 100, 100), 5.0)
		by_hexa = {}
		for p in pieces:
			by_hexa.setdefault(p.hexa_no, []).append(p)
		hexa = next(v for v in by_hexa.values() if len(v) == 6 and all(p.full for p in v))
		for p in hexa:
			centre = p.polygon_utm.exterior.coords[0]  # rings start at the hexa centre
			c = p.polygon_utm.centroid
			off = (_bearing(centre, (c.x, c.y)) - 60 * p.t + 180) % 360 - 180
			self.assertAlmostEqual(off, 0, delta=0.5)

	def test_multipolygon_piece_keeps_largest(self):
		# A C shape whose notch (0.4 m wide) splits some triangles in two.
		outer = box(0, 0, 60, 60)
		notch = box(10, 29.8, 60, 30.2)
		c_shape = outer.difference(notch)
		pieces = cut(c_shape, 5.0)
		for p in pieces:
			self.assertEqual(p.polygon_utm.geom_type, "Polygon")
		# Some triangle straddled the notch and lost its smaller half.
		split = [p for p in pieces if not p.full and p.polygon_utm.distance(notch) < 1e-6
			and p.polygon_utm.bounds[1] < 29.8 and p.polygon_utm.bounds[3] <= 29.8 + 1e-6]
		self.assertTrue(split)
		self.assertTrue(all(p.polygon_utm.intersection(notch).area < 1e-6 for p in pieces))

	def test_slivers_under_half_m2_dropped(self):
		# A thin strip only 0.05 m tall: every piece of it is under 0.5 m² except
		# where 10+ m of strip falls in one triangle; with 5 m sides none does.
		strip = box(0, 0, 40, 0.05)
		pieces = cut(strip, 5.0)
		self.assertEqual(pieces, [])
		for p in cut(box(0, 0, 30, 30), 5.0):
			self.assertGreaterEqual(p.polygon_utm.area, 0.5)


def _hexa_centre(pieces, n):
	full = [p for p in pieces if p.hexa_no == n and p.full]
	if full:
		return full[0].polygon_utm.exterior.coords[0]
	c = pieces[[p.hexa_no for p in pieces].index(n)].polygon_utm.centroid
	return (c.x, c.y)
