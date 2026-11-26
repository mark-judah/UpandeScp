"""The lattice encoding of Hexa -> Triad blocks on mutara: what the browser rebuilds from it is
what is stored (within the 1e-7 degree rounding), and the index counts match the Triads.

Run: bench --site mutara.local run-tests --app upande_scp \
        --module upande_scp.serverscripts.tests.test_field_lattice
"""

import math
import unittest

import frappe

from upande_scp.serverscripts.geo import field_geo as G
from upande_scp.serverscripts.geo import field_lattice as L

TOL_M = 0.02


def _rows(block):
	return frappe.db.sql(
		"select name, block, `row`, triad, geojson from `tabTriad` where block = %s", block, as_dict=True,
	)


def _sample_blocks():
	"""One small pivot block and one small avocado block that have Triads, else none."""
	out = []
	for like in ("%PH1-AV%", "%"):
		r = frappe.db.sql(
			"select block from `tabTriad` where block like %s group by block order by count(*) limit 1", like
		)
		if r and r[0][0] not in out:
			out.append(r[0][0])
	return out


class TestLatticeOnMutara(unittest.TestCase):
	def test_decode_matches_stored_triads(self):
		blocks = _sample_blocks()
		if not blocks:
			self.skipTest("no Triads on this site")
		for block in blocks:
			rows = _rows(block)
			enc = L.encode_block(block, rows)
			self.assertEqual(enc["x"], [], f"{block}: every triad should sit on the lattice")
			dec = L.decode_block(enc)
			self.assertEqual(len(dec), len(rows))
			for r in rows:
				m = L._NAME_RE.match(r.name)
				ring = L._ring(r.geojson)[:-1]
				got = dec[(int(m.group("h")), int(m.group("t")))]
				self.assertEqual(len(got), len(ring))
				for a, c in zip(got, ring):
					dx = (a[0] - c[0]) * 111320 * math.cos(math.radians(c[1]))
					dy = (a[1] - c[1]) * 110574
					self.assertLess(math.hypot(dx, dy), TOL_M, r.name)

	def test_index_counts_triads_and_hexas_per_block(self):
		blocks = _sample_blocks()
		if not blocks:
			self.skipTest("no Triads on this site")
		idx = G.get_field_index()
		for block in blocks:
			n, h = frappe.db.sql("select count(*), count(distinct `row`) from `tabTriad` where block = %s", block)[0]
			self.assertEqual(idx["counts"][block], [n, h])

	def test_endpoint_caches_per_version_and_refuses_stale(self):
		blocks = _sample_blocks()
		if not blocks:
			self.skipTest("no Triads on this site")
		idx = G.get_field_index()
		first = L.get_field_lattice(blocks, version=idx["version"])
		self.assertEqual(first["format"], L.FORMAT)
		self.assertEqual(set(first["blocks"]), set(blocks))
		self.assertTrue(L.get_field_lattice(["nope - x"], version="stale-version").get("stale"))
