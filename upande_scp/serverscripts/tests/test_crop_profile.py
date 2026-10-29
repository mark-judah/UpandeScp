"""Crop profiles come from where a crop is planted, never from its name."""

import unittest

from upande_scp.serverscripts.common import crop_profile as CP

WH = {
	"Farm": {"parent_warehouse": None, "warehouse_type": "Farm"},
	"Phase 1": {"parent_warehouse": "Farm", "warehouse_type": "Phase"},
	"Sec A": {"parent_warehouse": "Phase 1", "warehouse_type": "Section"},
	"B1": {"parent_warehouse": "Sec A", "warehouse_type": "Block"},
	"Pivot 1": {"parent_warehouse": "Farm", "warehouse_type": "Pivot"},
	"P1-B1": {"parent_warehouse": "Pivot 1", "warehouse_type": "Block"},
	"GH1": {"parent_warehouse": None, "warehouse_type": "Greenhouse"},
}
ST = [
	{"name": "B1", "warehouse_type": "Block", "custom_farm": "M"},
	{"name": "P1-B1", "warehouse_type": "Block", "custom_farm": "M"},
	{"name": "GH1", "warehouse_type": "Greenhouse", "custom_farm": "K"},
]


class TestCropProfile(unittest.TestCase):
	def test_levels_and_block_grown(self):
		out = CP.build_profiles(
			[{"name": "Avocado"}, {"name": "Passion Fruit"}, {"name": "Rose"}],
			{"Rose": {"K"}},
			ST,
			{"B1": "Avocado", "P1-B1": "Passion Fruit", "GH1": None},
			WH,
			"Greenhouse",
		)
		by = {p["crop"]: p for p in out}
		self.assertEqual(by["Avocado"]["level_labels"], ["Phase", "Section"])
		self.assertEqual(by["Passion Fruit"]["level_labels"], ["Pivot"])
		self.assertEqual(by["Passion Fruit"]["slug"], "passion-fruit")
		self.assertTrue(by["Passion Fruit"]["block_grown"])
		# Nothing resolves to Rose: falls back to the stations of its farms.
		self.assertEqual(by["Rose"]["station_type"], "Greenhouse")
		self.assertFalse(by["Rose"]["block_grown"])
		self.assertEqual(by["Rose"]["level_labels"], [])

	def test_crop_without_stations_is_not_block_grown(self):
		out = CP.build_profiles([{"name": "Fallow"}], {}, ST, {}, WH, "Greenhouse")
		self.assertFalse(out[0]["block_grown"])
