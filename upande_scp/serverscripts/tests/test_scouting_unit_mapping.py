"""createScoutingEntry maps an entry with no row/bed to the nearest unit from GPS.

Run: bench --site mutara.local run-tests \
        --module upande_scp.serverscripts.tests.test_scouting_unit_mapping
"""

import json
import time
from types import SimpleNamespace
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from upande_scp.serverscripts.mobile import create_scouting_entry as CSE
from upande_scp.serverscripts.mobile import geo_utils

PH1_BLOCK = "PH1-B1 - MUT"
P1_BLOCK = "P1-B1 - MUT"
GH = "_Test SCP Units GH 1 - MUT"
DAY = "2026-10-01"
SETTINGS = "Scouting and Crop Protection Settings"
M_PER_DEG = 111_320.0


class TestScoutingUnitMapping(IntegrationTestCase):
	def setUp(self):
		frappe.db.set_single_value(SETTINGS, "save_without_gps_fix", 1)
		frappe.clear_cache()
		geo_utils.clear_zone_cache()
		geo_utils.clear_tree_cache()

	def tearDown(self):
		frappe.db.rollback()
		frappe.clear_cache()
		geo_utils.clear_zone_cache()
		geo_utils.clear_tree_cache()

	def _post(self, **over):
		user = frappe.db.get_value("Employee", {"user_id": ["is", "set"]}, "user_id")
		entry = {
			"scouts_name": user,
			"block": PH1_BLOCK,
			"date_of_capture": DAY,
			"time_of_capture": "09:15:00",
		}
		entry.update(over)
		prev = getattr(frappe.local, "request", None)
		try:
			frappe.local.request = SimpleNamespace(get_json=lambda: entry)
			frappe.local.response = frappe._dict()
			with patch.object(frappe.db, "commit"), patch.object(frappe, "publish_realtime"):
				CSE.createScoutingEntry()
			result = frappe.local.response["data"][0]
		finally:
			frappe.local.request = prev
		return result

	def _send(self, **over):
		result = self._post(**over)
		self.assertEqual(result["status"], "success", result)
		return frappe.get_doc("Scouting Entry", result["name"])

	def _tree(self):
		t = frappe.db.get_value(
			"Orchard Tree", {"block": PH1_BLOCK, "geojson": ["is", "set"]}, ["name", "row", "geojson"], as_dict=True
		)
		lon, lat = json.loads(t.geojson)["geometry"]["coordinates"][:2]
		return t, lat, lon

	def test_block_entry_without_row_maps_to_nearest_tree(self):
		t, lat, lon = self._tree()
		doc = self._send(latitude=lat, longitude=lon, accuracy=3)
		self.assertEqual(doc.tree, t.name)
		self.assertEqual(doc.row, t.row)
		self.assertEqual(doc.mapping_status, "Mapped")

	def test_block_entry_far_from_any_tree_is_to_be_mapped(self):
		_, lat, lon = self._tree()
		min_lat = min(
			json.loads(g)["geometry"]["coordinates"][1]
			for (g,) in frappe.db.sql(
				"select geojson from `tabOrchard Tree` where block=%s and geojson is not null", PH1_BLOCK
			)
		)
		doc = self._send(latitude=min_lat - 500 / M_PER_DEG, longitude=lon, accuracy=3)
		self.assertFalse(doc.tree)
		self.assertFalse(doc.row)
		self.assertEqual(doc.mapping_status, "To be mapped")

	def test_entry_without_coordinates_is_to_be_mapped(self):
		doc = self._send(latitude=None, longitude=None, accuracy=None)
		self.assertFalse(doc.tree)
		self.assertEqual(doc.mapping_status, "To be mapped")

	def test_scout_picked_row_is_mapped_as_before(self):
		t, lat, lon = self._tree()
		doc = self._send(latitude=lat, longitude=lon, accuracy=3, row=t.row)
		self.assertEqual(doc.row, t.row)
		self.assertEqual(doc.tree, t.name)
		self.assertEqual(doc.mapping_status, "Mapped")

	def test_scout_picked_row_without_tree_match_still_mapped(self):
		doc = self._send(latitude=-0.5, longitude=36.7, accuracy=3, row=f"{PH1_BLOCK} - Row 1")
		self.assertEqual(doc.row, f"{PH1_BLOCK} - Row 1")
		self.assertEqual(doc.mapping_status, "Mapped")

	def _zone(self, bed_name, greenhouse, lon, lat):
		"""A Zone line (and its Bed when missing) as fixture; validation is skipped
		because mutara's farm type has no Has Zones / Has Beds level."""
		if bed_name is None:
			bed = frappe.get_doc(
				{"doctype": "Bed", "greenhouse": greenhouse, "unit_type": "Bed", "bed": 901}
			)
			bed.flags.ignore_validate = True
			bed.insert(ignore_permissions=True)
			bed_name = bed.name
		line = {"type": "LineString", "coordinates": [[lon, lat], [lon + 0.0002, lat]]}
		zone = frappe.get_doc(
			{"doctype": "Zone", "bed": bed_name, "zone": 1, "greenhouse": greenhouse, "geojson": json.dumps(line)}
		)
		zone.flags.ignore_validate = True
		zone.insert(ignore_permissions=True)
		geo_utils.clear_zone_cache()
		return zone

	def test_greenhouse_entry_without_bed_maps_to_nearest_zone(self):
		# North Pole-side of Kenya, away from other zones.
		zone = self._zone(None, GH, 36.9, 0.2)
		doc = self._send(
			block=None, greenhouse=GH, latitude=0.2 + 1 / M_PER_DEG, longitude=36.9001, accuracy=3
		)
		self.assertEqual(doc.zone, zone.name)
		self.assertEqual(doc.bed, zone.bed)
		self.assertEqual(doc.mapping_status, "Mapped")

	def test_greenhouse_entry_far_from_zone_is_to_be_mapped(self):
		self._zone(None, GH, 36.9, 0.2)
		doc = self._send(block=None, greenhouse=GH, latitude=0.2 + 500 / M_PER_DEG, longitude=36.9001, accuracy=3)
		self.assertFalse(doc.zone)
		self.assertEqual(doc.mapping_status, "To be mapped")

	def test_block_without_trees_maps_to_nearest_row_via_zone(self):
		row = f"{P1_BLOCK} - Row 1"
		self._zone(row, P1_BLOCK, 36.8, 0.3)
		doc = self._send(block=P1_BLOCK, latitude=0.3 + 1 / M_PER_DEG, longitude=36.8001, accuracy=3)
		self.assertFalse(doc.tree)
		self.assertEqual(doc.row, row)
		self.assertEqual(doc.mapping_status, "Mapped")

	def test_helpers_are_limited_to_the_block(self):
		t, lat, lon = self._tree()
		self.assertEqual(geo_utils.nearest_unit_in_block(lat, lon, 3, PH1_BLOCK), (t.name, t.row))
		self.assertEqual(geo_utils.nearest_unit_in_block(lat, lon, 3, "PH1-B2 - MUT"), (None, None))
		self.assertEqual(geo_utils.nearest_unit_in_block(lat, lon, 3, None), (None, None))
		self.assertIsNone(geo_utils.nearest_zone_in_greenhouse(lat, lon, 3, GH))

	def test_mapped_insert_is_fast_with_warm_cache(self):
		t, lat, lon = self._tree()
		self._send(latitude=lat, longitude=lon, accuracy=3)  # warms the cache
		start = time.monotonic()
		geo_utils.nearest_unit_in_block(lat, lon, 3, PH1_BLOCK)
		self.assertLess(time.monotonic() - start, 0.5)
