"""createScoutingEntry maps an entry with no row/bed to the nearest unit from GPS.

Run: bench --site mutara.local run-tests \
        --module upande_scp.serverscripts.tests.test_scouting_unit_mapping
"""

import json
import math
import time
from types import SimpleNamespace
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from pyproj import Transformer

from upande_scp.serverscripts.mobile import create_scouting_entry as CSE
from upande_scp.serverscripts.mobile import geo_utils

# Fixture blocks (raw-inserted inside the test transaction, rolled back in tearDown).
PH1_BLOCK = "_Test SCP Map Tree Blk - MUT"  # Row + Orchard Trees with Point geojson
OTHER_BLOCK = "_Test SCP Map Other Blk - MUT"
HEXA_BLOCK = "_Test SCP Map Hexa Blk - MUT"  # one Hexa bed + six triangle Triads
HEXA = f"{HEXA_BLOCK} - Hexa 1"
TREE_ROW = f"{PH1_BLOCK} - Row 1"
TRI_ORIGIN = (36.70, 0.10)  # lng, lat; away from real blocks
TREE_ORIGIN = (36.60, 0.10)
SIDE = 5.0
EPSG = "EPSG:32637"
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
		self._build_fixtures()

	def _build_fixtures(self):
		company = frappe.db.get_value("Company", {}, "name")
		for blk in (PH1_BLOCK, OTHER_BLOCK, HEXA_BLOCK):
			frappe.get_doc(
				{"doctype": "Warehouse", "name": blk, "warehouse_name": blk, "company": company, "is_group": 0}
			).db_insert()
		# Trees: three in a row, 10 m apart going east, with Point geojson.
		fwd = Transformer.from_crs("EPSG:4326", EPSG, always_xy=True)
		inv = Transformer.from_crs(EPSG, "EPSG:4326", always_xy=True)
		frappe.get_doc({"doctype": "Bed", "name": TREE_ROW, "greenhouse": PH1_BLOCK, "unit_type": "Row", "bed": 1}).db_insert()
		x0, y0 = fwd.transform(*TREE_ORIGIN)
		self.tree_pts = {}
		for n in (1, 2, 3):
			lng, lat = inv.transform(x0 + 10 * n, y0)
			name = f"{TREE_ROW} - Tree {n}"
			feature = {"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [lng, lat]}}
			frappe.get_doc(
				{"doctype": "Orchard Tree", "name": name, "row": TREE_ROW, "tree": n, "block": PH1_BLOCK,
				 "geojson": json.dumps(feature)}
			).db_insert()
			self.tree_pts[name] = (lat, lng)
		# Hexa bed + six triangles (pointy-top hexagon, circumradius SIDE, centre cx, cy).
		frappe.get_doc({"doctype": "Bed", "name": HEXA, "greenhouse": HEXA_BLOCK, "unit_type": "Hexa", "bed": 1}).db_insert()
		cx, cy = fwd.transform(*TRI_ORIGIN)
		self.centre = (cx, cy)
		for t in range(1, 7):
			a0, a1 = math.radians(30 + 60 * (t - 1)), math.radians(30 + 60 * t)
			pts = [(cx, cy), (cx + SIDE * math.cos(a0), cy + SIDE * math.sin(a0)),
				   (cx + SIDE * math.cos(a1), cy + SIDE * math.sin(a1)), (cx, cy)]
			ring = [list(inv.transform(x, y)) for x, y in pts]
			feature = {"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [ring]}}
			frappe.get_doc(
				{"doctype": "Triad", "name": f"{HEXA} - Triad {t}", "row": HEXA, "triad": t, "block": HEXA_BLOCK,
				 "geojson": json.dumps(feature)}
			).db_insert()
		self.inv = inv

	def _utm_latlng(self, dx, dy):
		lng, lat = self.inv.transform(self.centre[0] + dx, self.centre[1] + dy)
		return lat, lng

	def _triad_point(self, t, frac=0.5):
		"""A point inside triangle t, on the bisector from the centre."""
		a = math.radians(30 + 60 * (t - 1) + 30)
		r = SIDE * math.cos(math.radians(30)) * frac * 1.0
		return self._utm_latlng(r * math.cos(a), r * math.sin(a))

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
		name = f"{TREE_ROW} - Tree 2"
		lat, lon = self.tree_pts[name]
		return frappe._dict(name=name, row=TREE_ROW), lat, lon

	def test_block_entry_without_row_maps_to_nearest_tree(self):
		t, lat, lon = self._tree()
		doc = self._send(latitude=lat, longitude=lon, accuracy=3)
		self.assertEqual(doc.tree, t.name)
		self.assertEqual(doc.row, t.row)
		self.assertEqual(doc.mapping_status, "Mapped")

	def test_endpoint_result_carries_mapping_status_tree_and_row(self):
		t, lat, lon = self._tree()
		result = self._post(latitude=lat, longitude=lon, accuracy=3)
		self.assertEqual(result["status"], "success", result)
		self.assertEqual(result["mapping_status"], "Mapped")
		self.assertEqual(result["tree"], t.name)
		self.assertEqual(result["row"], t.row)
		unmapped = self._post(time_of_capture="09:30:00")
		self.assertEqual(unmapped["mapping_status"], "To be mapped")
		self.assertFalse(unmapped["tree"])

	def test_block_entry_far_from_any_tree_is_to_be_mapped(self):
		_, lat, lon = self._tree()
		min_lat = min(lat for lat, _ in self.tree_pts.values())
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
		doc = self._send(latitude=-0.5, longitude=36.7, accuracy=3, row=TREE_ROW)
		self.assertEqual(doc.row, TREE_ROW)
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
		row = f"{OTHER_BLOCK} - Row 1"
		frappe.get_doc(
			{"doctype": "Bed", "name": row, "greenhouse": OTHER_BLOCK, "unit_type": "Row", "bed": 1}
		).db_insert()
		self._zone(row, OTHER_BLOCK, 36.8, 0.3)
		doc = self._send(block=OTHER_BLOCK, latitude=0.3 + 1 / M_PER_DEG, longitude=36.8001, accuracy=3)
		self.assertFalse(doc.tree)
		self.assertEqual(doc.row, row)
		self.assertEqual(doc.mapping_status, "Mapped")

	def _desk_entry(self, **fields):
		doc = frappe.get_doc(
			{
				"doctype": "Scouting Entry",
				"scouts_name": frappe.db.get_value("Employee", {"user_id": ["is", "set"]}, "name"),
				"date_of_capture": DAY,
				"time_of_capture": "09:15:00",
				**fields,
			}
		)
		doc.insert(ignore_permissions=True)
		return doc

	def test_desk_entry_with_tree_is_mapped(self):
		t, _, _ = self._tree()
		doc = self._desk_entry(block=PH1_BLOCK, row=t.row, tree=t.name)
		self.assertEqual(doc.mapping_status, "Mapped")

	def test_desk_entry_without_unit_is_to_be_mapped(self):
		doc = self._desk_entry(block=PH1_BLOCK)
		self.assertEqual(doc.mapping_status, "To be mapped")

	def test_block_index_is_one_block_and_reused(self):
		t, lat, lon = self._tree()
		geo_utils.nearest_unit_in_block(lat, lon, 3, PH1_BLOCK)
		self.assertEqual(list(geo_utils._block_tree_cache), [(geo_utils.get_dynamic_utm_epsg(lat, lon), PH1_BLOCK)])
		self.assertFalse(geo_utils._tree_cache)  # the farm-wide cache is not built

	def test_helpers_are_limited_to_the_block(self):
		t, lat, lon = self._tree()
		self.assertEqual(geo_utils.nearest_unit_in_block(lat, lon, 3, PH1_BLOCK), (t.name, t.row))
		self.assertEqual(geo_utils.nearest_unit_in_block(lat, lon, 3, OTHER_BLOCK), (None, None))
		self.assertEqual(geo_utils.nearest_unit_in_block(lat, lon, 3, None), (None, None))
		self.assertIsNone(geo_utils.nearest_zone_in_greenhouse(lat, lon, 3, GH))

	def test_mapped_insert_is_fast_with_warm_cache(self):
		t, lat, lon = self._tree()
		self._send(latitude=lat, longitude=lon, accuracy=3)  # warms the cache
		start = time.monotonic()
		geo_utils.nearest_unit_in_block(lat, lon, 3, PH1_BLOCK)
		self.assertLess(time.monotonic() - start, 0.5)

	# ---------------------------------------------------------------- triads

	def test_point_inside_triangle_maps_it(self):
		lat, lng = self._triad_point(3)
		self.assertEqual(geo_utils.triad_in_block(lat, lng, 3, HEXA_BLOCK), (f"{HEXA} - Triad 3", HEXA))
		doc = self._send(block=HEXA_BLOCK, latitude=lat, longitude=lng, accuracy=3)
		self.assertEqual(doc.triad, f"{HEXA} - Triad 3")
		self.assertEqual(doc.mapping_status, "Mapped")

	def test_stale_row_that_no_longer_exists_is_dropped_and_mapped_by_gps(self):
		# A phone that cached a block's old placeholder row keeps sending it after the
		# block was regridded into Hexas and the row deleted: the entry must still save,
		# placed on the triad under its GPS point, not be refused for a missing row.
		lat, lng = self._triad_point(3)
		doc = self._send(block=HEXA_BLOCK, row=f"{HEXA_BLOCK} - Row 1", latitude=lat, longitude=lng, accuracy=3)
		self.assertEqual(doc.triad, f"{HEXA} - Triad 3")
		self.assertEqual(doc.row, HEXA)
		self.assertEqual(doc.mapping_status, "Mapped")

	def test_point_on_shared_edge_is_deterministic(self):
		# The edge centre -> V(90 deg) is shared by triads 1 and 2.
		lat, lng = self._utm_latlng(0, SIDE / 2)
		results = {geo_utils.triad_in_block(lat, lng, 3, HEXA_BLOCK) for _ in range(5)}
		self.assertEqual(results, {(f"{HEXA} - Triad 1", HEXA)})

	def test_point_outside_within_buffer_takes_nearest(self):
		# 1 m beyond the outer edge of triangle 1 (outer edge midpoint at 60 deg).
		a = math.radians(60)
		d = SIDE * math.cos(math.radians(30)) + 1.0
		lat, lng = self._utm_latlng(d * math.cos(a), d * math.sin(a))
		self.assertEqual(geo_utils.triad_in_block(lat, lng, 3, HEXA_BLOCK), (f"{HEXA} - Triad 1", HEXA))

	def test_point_beyond_buffer_unmapped(self):
		lat, lng = self._utm_latlng(100, 100)
		self.assertEqual(geo_utils.triad_in_block(lat, lng, 3, HEXA_BLOCK), (None, None))
		doc = self._send(block=HEXA_BLOCK, latitude=lat, longitude=lng, accuracy=3)
		self.assertFalse(doc.triad)
		self.assertEqual(doc.mapping_status, "To be mapped")

	def test_triad_search_stays_in_block(self):
		lat, lng = self._triad_point(2)
		self.assertEqual(geo_utils.triad_in_block(lat, lng, 3, OTHER_BLOCK), (None, None))
		self.assertEqual(geo_utils.triad_in_block(lat, lng, 3, None), (None, None))

	def test_deleted_triad_not_served_after_stamp_bump(self):
		from upande_scp.serverscripts.geo.field_geo import bump_geo_version

		lat, lng = self._triad_point(3)
		self.assertEqual(geo_utils.triad_in_block(lat, lng, 3, HEXA_BLOCK)[0], f"{HEXA} - Triad 3")
		# A regenerate in another process deletes the Triad and bumps the shared stamp;
		# this process's memory is not cleared.
		frappe.db.delete("Triad", {"name": f"{HEXA} - Triad 3"})
		bump_geo_version()
		name, _hexa = geo_utils.triad_in_block(lat, lng, 3, HEXA_BLOCK)
		self.assertNotEqual(name, f"{HEXA} - Triad 3")

	def test_entry_stores_hexa_in_row_and_triad(self):
		lat, lng = self._triad_point(5)
		result = self._post(block=HEXA_BLOCK, latitude=lat, longitude=lng, accuracy=3)
		self.assertEqual(result["status"], "success", result)
		self.assertEqual(result["triad"], f"{HEXA} - Triad 5")
		self.assertEqual(result["row"], HEXA)
		self.assertFalse(result["tree"])
		doc = frappe.get_doc("Scouting Entry", result["name"])
		self.assertEqual((doc.row, doc.triad), (HEXA, f"{HEXA} - Triad 5"))

	def test_tree_block_still_maps_trees(self):
		t, lat, lon = self._tree()
		result = self._post(latitude=lat, longitude=lon, accuracy=3)
		self.assertEqual(result["tree"], t.name)
		self.assertEqual(result["row"], t.row)
		self.assertFalse(result["triad"])
