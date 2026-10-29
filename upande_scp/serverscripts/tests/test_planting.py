"""Crop resolution for stations (common.planting) and the station filter.

Pure tests need no data. The DB tests build throwaway Crop Scouted records and
warehouses inside the test transaction (rolled back in tearDown) and read the
seeded Production Crop Cycles of mutara.local (P1-B1: Cabbage closed from
2025-12-27, Potatoes active from 2026-09-13); they skip where that data is absent.

Run: bench --site mutara.local run-tests --app upande_scp \
        --module upande_scp.serverscripts.tests.test_planting
"""

import unittest
from unittest import mock

import frappe

from upande_scp.serverscripts.common import farm_map, planting as P

UNIT = "P1-B1"
ACTIVE_DAY = "2026-10-01"  # Potatoes cycle (Active since 2026-09-13)
CLOSED_DAY = "2026-01-01"  # only the closed Cabbage cycle has started


class TestPure(unittest.TestCase):
	def test_latest_start_wins(self):
		cycles = [
			{"item": "A", "start_date": "2026-01-01", "status": "Active"},
			{"item": "B", "start_date": "2026-05-01", "status": "Harvesting"},
		]
		self.assertEqual(P.pick_cycle_item(cycles, "2026-06-01"), "B")

	def test_closed_and_future_cycles_are_ignored(self):
		cycles = [
			{"item": "A", "start_date": "2026-01-01", "status": "Closed"},
			{"item": "B", "start_date": "2026-09-01", "status": "Planned"},
		]
		self.assertIsNone(P.pick_cycle_item(cycles, "2026-06-01"))
		self.assertEqual(P.pick_cycle_item(cycles, "2026-09-01"), "B")

	def test_variety_item_follows_its_base_item(self):
		m = {"Maize": "Corn", "Cabbage - Gloria F1": "Cabbage"}
		self.assertEqual(P.crop_for_item("Maize - H513", m), "Corn")
		self.assertEqual(P.crop_for_item("Cabbage - Gloria F1", m), "Cabbage")
		self.assertIsNone(P.crop_for_item("Cabbage - Other", m))
		self.assertIsNone(P.crop_for_item("Wheat - X", m))
		self.assertIsNone(P.crop_for_item(None, m))

	def test_unit_fallback_needs_a_known_crop(self):
		self.assertEqual(P.unit_fallback_crop("Avocado", {"Avocado"}), "Avocado")
		self.assertIsNone(P.unit_fallback_crop("Fruits & Vegetables", {"Avocado"}))
		self.assertIsNone(P.unit_fallback_crop(None, {"Avocado"}))

	def test_nearest_custom_crop_walks_up(self):
		wh = {
			"blk": {"parent_warehouse": "sec", "custom_crop": None},
			"sec": {"parent_warehouse": "phase", "custom_crop": None},
			"phase": {"parent_warehouse": None, "custom_crop": "Avocado"},
		}
		self.assertEqual(P.nearest_custom_crop("blk", wh), "Avocado")
		wh["sec"]["custom_crop"] = "Other"
		self.assertEqual(P.nearest_custom_crop("blk", wh), "Other")
		wh["blk"]["custom_crop"] = "Own"
		self.assertEqual(P.nearest_custom_crop("blk", wh), "Own")

	def test_parent_cycle_does_not_hang(self):
		wh = {"a": {"parent_warehouse": "b"}, "b": {"parent_warehouse": "a"}}
		self.assertIsNone(P.nearest_custom_crop("a", wh))

	def test_empty_inputs(self):
		self.assertEqual(P.crops_for_stations([]), {})
		self.assertIsNone(P.crop_for_station(""))
		self.assertEqual(P.stations_for_crop("", "x"), [])


class TestResolution(unittest.TestCase):
	def setUp(self):
		if not frappe.db.exists("Production Crop Cycle", {"unit": UNIT, "item": "Potatoes", "status": "Active"}):
			self.skipTest("mutara production seed data absent")
		self.company_abbr = frappe.db.get_value("Company", {}, "abbr")
		self.crop_pot = self._crop("_T Potato Crop", ["Potatoes"])
		self.crop_cab = self._crop("_T Cabbage Crop", ["Cabbage"])
		self.crop_avo = self._crop("_T Avo Crop", [])

	def tearDown(self):
		frappe.db.rollback()

	def _crop(self, name, items):
		doc = frappe.get_doc(
			{
				"doctype": "Crop Scouted",
				"crop_name": name,
				"production_items": [{"item": i} for i in items],
			}
		).insert(ignore_permissions=True)
		return doc.name

	def _wh(self, name, parent=None, **kw):
		doc = frappe.get_doc(
			{
				"doctype": "Warehouse",
				"warehouse_name": name,
				"company": frappe.db.get_value("Company", {}, "name"),
				"parent_warehouse": parent,
				"is_group": kw.pop("is_group", 0),
				"custom_farm": kw.pop("custom_farm", frappe.db.get_value("Farm", {}, "name")),
				**kw,
			}
		).insert(ignore_permissions=True)
		return doc.name

	def test_cycle_wins_over_custom_crop(self):
		st = self._wh("_T Pivot Block", custom_production_unit=UNIT, custom_crop=self.crop_avo)
		self.assertEqual(P.crop_for_station(st, ACTIVE_DAY), self.crop_pot)

	def test_closed_cycle_falls_back_to_custom_crop(self):
		st = self._wh("_T Pivot Block", custom_production_unit=UNIT, custom_crop=self.crop_avo)
		self.assertEqual(P.crop_for_station(st, CLOSED_DAY), self.crop_avo)

	def test_closed_cycle_without_fallback_is_none(self):
		st = self._wh("_T Pivot Block", custom_production_unit=UNIT)
		self.assertIsNone(P.crop_for_station(st, CLOSED_DAY))

	def test_ancestor_custom_crop_is_inherited(self):
		phase = self._wh("_T Phase", is_group=1, custom_crop=self.crop_avo)
		sec = self._wh("_T Section", parent=phase, is_group=1)
		blk = self._wh("_T Block", parent=sec)
		self.assertEqual(P.crop_for_station(blk), self.crop_avo)

	def test_unconfigured_item_falls_through(self):
		# Onion maps to no crop here, so the ancestor's crop is used. The site
		# seed maps it, so unmap it for this test (rolled back with the rest).
		frappe.db.delete("SCP Crop Production Item", {"item": "Onion"})
		phase = self._wh("_T Phase", is_group=1, custom_crop=self.crop_avo)
		blk = self._wh("_T Block", parent=phase, custom_production_unit="P2-B2")
		self.assertEqual(P.crop_for_station(blk, "2026-07-01"), self.crop_avo)

	def test_no_production_app_uses_custom_crop_only(self):
		st = self._wh("_T Pivot Block", custom_production_unit=UNIT, custom_crop=self.crop_avo)
		with mock.patch.object(P, "production_available", return_value=False):
			self.assertEqual(P.crop_for_station(st, ACTIVE_DAY), self.crop_avo)

	def test_batched_matches_single_and_is_query_bounded(self):
		phase = self._wh("_T Phase", is_group=1, custom_crop=self.crop_avo)
		a = self._wh("_T A", parent=phase)
		b = self._wh("_T B", custom_production_unit=UNIT)
		c = self._wh("_T C")
		stations = [a, b, c]
		for day in (ACTIVE_DAY, CLOSED_DAY):
			batched = P.crops_for_stations(stations, day)
			self.assertEqual(batched, {s: P.crop_for_station(s, day) for s in stations})
		# Add many more stations: query count must not grow with them.
		def count(sts):
			frappe.db.sql("select 1")
			before = frappe.db.sql("show session status like 'Questions'")[0][1]
			P.crops_for_stations(sts, ACTIVE_DAY)
			after = frappe.db.sql("show session status like 'Questions'")[0][1]
			return int(after) - int(before)

		more = stations + [self._wh(f"_T M{i}", parent=phase) for i in range(15)]
		self.assertLessEqual(count(more), count(stations) + 1)

	def test_stations_for_crop_and_farm_filter(self):
		farm = frappe.db.get_value("Farm", {}, "name")
		if not farm:
			self.skipTest("no Farm")
		wt = frappe.db.get_value("Warehouse Type", "Block", "name")
		if not wt:
			self.skipTest("no Block warehouse type")
		pot = self._wh("_T Pot Blk", custom_farm=farm, warehouse_type="Block", custom_production_unit=UNIT)
		avo = self._wh("_T Avo Blk", custom_farm=farm, warehouse_type="Block", custom_crop=self.crop_avo)
		fallow = self._wh("_T Fallow Blk", custom_farm=farm, warehouse_type="Block")
		with mock.patch.object(farm_map, "station_types", return_value=("Block",)):
			unfiltered = farm_map.stations_for_farm(farm)
			self.assertTrue({pot, avo, fallow} <= set(unfiltered))
			self.assertEqual(farm_map.stations_for_farm(farm, crop=self.crop_pot, on_date=ACTIVE_DAY), [pot])
			self.assertEqual(farm_map.stations_for_farm(farm, crop=self.crop_avo), [avo])
			self.assertEqual(P.stations_for_crop(farm, self.crop_avo), [avo])


class TestMutaraBlocks(unittest.TestCase):
	"""The real Mutara blocks (skipped where that data is absent)."""

	def setUp(self):
		if not frappe.db.exists("Production Crop Cycle", {"unit": "P1-B9", "item": "Maize - H513"}):
			self.skipTest("mutara production seed data absent")

	def test_maize_blocks_are_corn(self):
		got = P.crops_for_stations(["P1-B9 - MUT", "P2-B9 - MUT"])
		self.assertEqual(set(got.values()), {"Corn"})

	def test_phase_two_avocado_without_cycles_is_avocado(self):
		self.assertEqual(P.crop_for_station("PH2-B4 - MUT"), "Avocado")
		self.assertEqual(P.crop_for_station("PH2-B1 - MUT"), "Avocado")

	def test_retired_units_resolve_to_nothing(self):
		got = P.crops_for_stations(["P3-B1 - MUT", "P4-B2 - MUT", "Avocado Block A - MUT"])
		self.assertEqual(set(got.values()), {None})
