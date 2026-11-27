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


class TestDurableCopy(unittest.TestCase):
	"""A cache clear must not make a map load rebuild the farm: index and lattices come back from
	the durable copy on disk (field_store), keyed by the data version."""

	def test_store_round_trip_and_prune(self):
		import os

		from upande_scp.serverscripts.geo import field_store as S

		S.put("lattice", "test_v_keep", "B 1 - X", {"h": [0, 1, 65], "e": [], "x": []})
		S.put("lattice", "test_v_old", "B 1 - X", {"h": []})
		self.assertEqual(S.get("lattice", "test_v_keep", "B 1 - X"), {"h": [0, 1, 65], "e": [], "x": []})
		self.assertIsNone(S.get("lattice", "test_v_keep", "other"))
		self.assertIsNone(S.get("lattice", "", "B 1 - X"))
		# a just-written file of another version survives (another worker may still serve it) ...
		S.prune({"test_v_keep"}, older_than_sec=3600)
		self.assertIsNotNone(S.get("lattice", "test_v_old", "B 1 - X"))
		# ... and goes once it is old; the kept version's files never go
		S.prune({"test_v_keep"}, older_than_sec=-1)
		self.assertIsNone(S.get("lattice", "test_v_old", "B 1 - X"))
		self.assertIsNotNone(S.get("lattice", "test_v_keep", "B 1 - X"))
		os.remove(S._path("lattice", "test_v_keep", "B 1 - X"))

	def test_index_and_lattice_survive_a_cache_clear_without_rebuilding(self):
		from unittest import mock

		blocks = _sample_blocks()
		if not blocks:
			self.skipTest("no Triads on this site")
		idx = G.get_field_index()
		first = L.get_field_lattice(blocks, version=idx["version"])
		cache = frappe.cache()
		cache.delete_value(f"{G.K_INDEX}::{idx['version']}")
		for b in blocks:
			cache.delete_value(L._lattice_key(idx["version"], b))
		with mock.patch.object(G, "_counts", side_effect=AssertionError("index rebuilt")), mock.patch.object(
			L, "_encode_blocks", side_effect=AssertionError("lattice rebuilt")
		):
			again = G.get_field_index()
			self.assertEqual(again["counts"], idx["counts"])
			got = L.get_field_lattice(blocks, version=idx["version"])
		self.assertEqual(got["blocks"], first["blocks"])
		# and Redis is refilled from disk
		self.assertIsNotNone(cache.get_value(L._lattice_key(idx["version"], blocks[0])))

	def test_lattice_without_a_version_uses_the_current_ones_copies(self):
		from unittest import mock

		blocks = _sample_blocks()
		if not blocks:
			self.skipTest("no Triads on this site")
		v = G._version("")
		L.get_field_lattice(blocks, version=v)
		with mock.patch.object(L, "_encode_blocks", side_effect=AssertionError("rebuilt")):
			self.assertEqual(L.get_field_lattice(blocks)["version"], v)

	def test_stamp_is_durable(self):
		frappe.cache().delete_value(G.K_GEO_STAMP)
		self.assertEqual(G._stamp(), frappe.db.get_global(G.STAMP_GLOBAL) or "")


class TestPrefetchBeds(unittest.TestCase):
	def test_hexa_cells_are_not_shipped_inline(self):
		from upande_scp.www.scp_app import _greenhouse_beds

		beds = {
			"GH 1 - KR": [{"name": "b1", "unit_type": "Bed"}, {"name": "b2", "unit_type": None}],
			"PH1-AV2B1 - MUT": [{"name": "h1", "unit_type": "Hexa"}],
			"P1-B1 - MUT": [{"name": "r1", "unit_type": "Row"}, {"name": "h2", "unit_type": "Hexa"}],
		}
		self.assertEqual(
			_greenhouse_beds(beds),
			{"GH 1 - KR": beds["GH 1 - KR"], "P1-B1 - MUT": [{"name": "r1", "unit_type": "Row"}]},
		)
		self.assertIsNone(_greenhouse_beds(None))
