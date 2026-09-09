"""Which warehouses a scout may be sent to.

The bundle the handset downloads used to treat *every* non-group warehouse of a
farm as a scouting station. That is how `Torongo GH18 - KR` — a warehouse created
for stock, with no beds and no type — reached a scout's picker and cost her six
days of captures. It also means a farm's chemical store, its CSU and its transit
warehouse were all offered as places to scout.

A station is not "anything attached to the farm". It is a warehouse of a type
that has field units under it: Greenhouse for roses, Block for avocado and
coffee. That list is configuration rather than a constant, because the next crop
will bring its own word for it.

On the live site 245 farm-linked warehouses carry no type at all and not one of
them has a single bed, while every warehouse that does have beds is typed
Greenhouse or Block — so this narrows the list without hiding anything real.
"""

import unittest

import frappe

from upande_scp.serverscripts.common import farm_map


class TestTheConfiguredTypes(unittest.TestCase):
	def test_it_falls_back_when_nothing_is_configured(self):
		"""A site that has never opened the setting must still work — and the
		fallback is the pair the rest of the app already hardcodes."""
		self.assertEqual(farm_map.station_types_from_rows([]), ("Greenhouse", "Block"))
		self.assertEqual(farm_map.station_types_from_rows(None), ("Greenhouse", "Block"))

	def test_it_reads_what_the_gm_configured(self):
		rows = [{"warehouse_type": "Greenhouse"}, {"warehouse_type": "Block"}, {"warehouse_type": "Orchard"}]
		self.assertEqual(farm_map.station_types_from_rows(rows), ("Greenhouse", "Block", "Orchard"))

	def test_blanks_are_dropped_rather_than_matching_everything(self):
		"""An empty row in the grid must not become a wildcard."""
		rows = [{"warehouse_type": "Greenhouse"}, {"warehouse_type": ""}, {"warehouse_type": None}]
		self.assertEqual(farm_map.station_types_from_rows(rows), ("Greenhouse",))

	def test_a_grid_of_only_blanks_falls_back(self):
		self.assertEqual(
			farm_map.station_types_from_rows([{"warehouse_type": ""}]), ("Greenhouse", "Block")
		)

	def test_duplicates_are_collapsed_but_order_is_kept(self):
		rows = [{"warehouse_type": "Block"}, {"warehouse_type": "Greenhouse"}, {"warehouse_type": "Block"}]
		self.assertEqual(farm_map.station_types_from_rows(rows), ("Block", "Greenhouse"))


class TestPickingStations(unittest.TestCase):
	"""`is_station` is the rule the bundle applies to each warehouse."""

	TYPES = ("Greenhouse", "Block")

	def test_a_greenhouse_leaf_is_a_station(self):
		self.assertTrue(farm_map.is_station({"warehouse_type": "Greenhouse", "is_group": 0}, self.TYPES))

	def test_an_untyped_warehouse_is_not(self):
		"""The Torongo GH18 case: no type, no beds, created for stock."""
		self.assertFalse(farm_map.is_station({"warehouse_type": None, "is_group": 0}, self.TYPES))

	def test_a_chemical_store_is_not(self):
		self.assertFalse(farm_map.is_station({"warehouse_type": "Stores", "is_group": 0}, self.TYPES))

	def test_a_block_group_is_a_station(self):
		"""An orchard block carries row sub-warehouses, so it is a group — and it
		is still the station that beds and traps link to."""
		self.assertTrue(farm_map.is_station({"warehouse_type": "Block", "is_group": 1}, self.TYPES))

	def test_a_greenhouse_group_is_not(self):
		"""`Torongo Greenhouses - KR` is a folder, not a place to scout."""
		self.assertFalse(farm_map.is_station({"warehouse_type": "Greenhouse", "is_group": 1}, self.TYPES))

	def test_a_configured_type_that_is_neither(self):
		"""A new crop's station type is trusted as a leaf, like Greenhouse."""
		types = ("Greenhouse", "Block", "Orchard")
		self.assertTrue(farm_map.is_station({"warehouse_type": "Orchard", "is_group": 0}, types))
		self.assertFalse(farm_map.is_station({"warehouse_type": "Orchard", "is_group": 1}, types))


class TestAgainstTheRealSite(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")

	def test_the_configured_list_resolves(self):
		types = farm_map.station_types()
		self.assertTrue(types)
		self.assertIn("Greenhouse", types)

	def test_no_warehouse_holding_beds_is_excluded(self):
		"""The safety property: narrowing to typed stations must not hide a place
		that demonstrably has field units."""
		types = farm_map.station_types()
		rows = frappe.db.sql(
			"""
			SELECT w.name, w.warehouse_type, w.is_group
			FROM   `tabWarehouse` w
			WHERE  w.disabled = 0
			  AND  EXISTS (SELECT 1 FROM `tabBed` b WHERE b.greenhouse = w.name)
			""",
			as_dict=True,
		)
		if not rows:
			self.skipTest("no beds on this site")
		hidden = [r["name"] for r in rows if not farm_map.is_station(r, types)]
		self.assertEqual(hidden, [], f"these hold beds but would be hidden: {hidden[:5]}")
