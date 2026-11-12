"""The map endpoints take one farm or several (JSON list / comma names).

Read-only: each test compares a several-farm call against the union of the
single-farm calls on this site's own data, so it holds whatever the data is.
"""
import json
import unittest

import frappe

from upande_scp.serverscripts.geo import get_orchard_trees, get_tanks_valves
from upande_scp.serverscripts.scouting import scouting_metrics_api as metrics
from upande_scp.serverscripts.traps import trap_location


class TestPlaceMultiMaps(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.flags.in_test = True
		cls.farms = [
			f for f in frappe.get_all("Warehouse", filters={"custom_farm": ["is", "set"]},
			                           pluck="custom_farm", distinct=True) if f
		][:3]

	def _pairs(self):
		if len(self.farms) < 2:
			self.skipTest("needs two farms")
		return self.farms[:2]

	def test_block_areas_union(self):
		a, b = self._pairs()
		both = metrics.get_block_areas(json.dumps([a, b]))
		expect = {**metrics.get_block_areas(a), **metrics.get_block_areas(b)}
		self.assertEqual(both, expect)
		self.assertEqual(metrics.get_block_areas(f"{a},{b}"), expect)
		self.assertEqual(metrics.get_block_areas(a), metrics.get_block_areas([a]))

	def test_block_areas_all_sentinel_means_no_filter(self):
		self.assertEqual(metrics.get_block_areas("__all__"), metrics.get_block_areas(None))

	def test_trap_locations_union(self):
		a, b = self._pairs()
		both = trap_location.get_trap_locations(json.dumps([a, b]))
		expect = {**trap_location.get_trap_locations(a), **trap_location.get_trap_locations(b)}
		self.assertEqual(both, expect)

	def test_tanks_valves_union(self):
		a, b = self._pairs()
		names = lambda fc: sorted(f["properties"]["asset_name"] for f in fc["features"])
		both = get_tanks_valves.get_tanks_valves_geojson(json.dumps([a, b]))
		single = get_tanks_valves.get_tanks_valves_geojson(a)
		other = get_tanks_valves.get_tanks_valves_geojson(b)
		self.assertEqual(names(both), sorted(names(single) + names(other)))
		self.assertEqual(names(get_tanks_valves.get_tanks_valves_geojson(json.dumps([a]))), names(single))

	def test_orchard_rows_concatenate(self):
		a, b = self._pairs()
		n = lambda r: len(r["rows"])
		both = get_orchard_trees.get_orchard_tree_rows(farm=json.dumps([a, b]))
		self.assertEqual(
			n(both),
			n(get_orchard_trees.get_orchard_tree_rows(farm=a)) + n(get_orchard_trees.get_orchard_tree_rows(farm=b)),
		)
		self.assertEqual(get_orchard_trees.get_orchard_tree_rows(farm="__all__"), {"rows": []})
