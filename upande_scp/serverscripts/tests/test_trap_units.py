"""A trap hung on a unit (Trap.unit_type + Trap.unit) — geometry, validation, endpoints.

Pure geometry first; the database tests raw-insert fixtures and roll back.

Run: bench --site <site> run-tests --module upande_scp.serverscripts.tests.test_trap_units
"""

import json
import unittest

import frappe

from upande_scp.serverscripts.common import custom_fields as cf
from upande_scp.serverscripts.traps import trap_location as TL
from upande_scp.serverscripts.traps import trap_units as TU

FARM = "_TEST TrapUnit Farm"
BLOCK = "_TEST TrapUnit Block"
OTHER = "_TEST TrapUnit Other Block"
HEX = [[36.0, 0.0], [36.00002, 0.0], [36.00003, 0.00002], [36.00002, 0.00004], [36.0, 0.00004], [35.99999, 0.00002], [36.0, 0.0]]


def feature(geometry):
	return json.dumps({"type": "Feature", "properties": {}, "geometry": geometry})


class TestTrapUnitGeometryPure(unittest.TestCase):
	def test_geometry_of_unwraps_collections_and_features(self):
		g = {"type": "Point", "coordinates": [36.1, 0.2]}
		self.assertEqual(TU.geometry_of(g), g)
		self.assertEqual(TU.geometry_of(json.dumps({"type": "Feature", "geometry": g})), g)
		self.assertEqual(TU.geometry_of({"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": g}]}), g)
		self.assertIsNone(TU.geometry_of(""))
		self.assertIsNone(TU.geometry_of("not json"))
		self.assertIsNone(TU.geometry_of({"type": "FeatureCollection", "features": []}))

	def test_centre_of_a_hexagon_ignores_the_closing_vertex(self):
		lat, lng = TU.centre_of({"type": "Polygon", "coordinates": [HEX]})
		self.assertAlmostEqual(lng, sum(p[0] for p in HEX[:-1]) / 6, places=9)
		self.assertAlmostEqual(lat, sum(p[1] for p in HEX[:-1]) / 6, places=9)

	def test_centre_of_a_point_and_a_line(self):
		self.assertEqual(TU.centre_of({"type": "Point", "coordinates": [36.5, 0.25]}), (0.25, 36.5))
		self.assertEqual(TU.centre_of({"type": "LineString", "coordinates": [[36.0, 0.0], [36.2, 0.4]]}), (0.2, 36.1))
		self.assertIsNone(TU.centre_of(None))

	def test_line_through_orders_points_and_needs_two(self):
		self.assertEqual(
			TU.line_through([(3, 36.3, 0.3), (1, 36.1, 0.1), (2, 36.2, 0.2)]),
			{"type": "LineString", "coordinates": [[36.1, 0.1], [36.2, 0.2], [36.3, 0.3]]},
		)
		self.assertIsNone(TU.line_through([(1, 36.1, 0.1)]))

	def test_station_field_per_unit_type(self):
		self.assertEqual(TU.unit_station_field("Triad"), "block")
		self.assertEqual(TU.unit_station_field("Orchard Tree"), "block")
		self.assertEqual(TU.unit_station_field("Bed"), "greenhouse")
		self.assertIsNone(TU.unit_station_field("Zone"))


class TestTrapUnitFields(unittest.TestCase):
	def test_trap_has_the_unit_fields(self):
		meta = frappe.get_meta("Trap")
		ut, u = meta.get_field("unit_type"), meta.get_field("unit")
		self.assertEqual(ut.fieldtype, "Select")
		self.assertEqual([o for o in ut.options.split("\n") if o], ["Triad", "Orchard Tree", "Bed"])
		self.assertEqual(u.fieldtype, "Dynamic Link")
		self.assertEqual(u.options, "unit_type")

	def test_warehouse_heat_style_is_declared(self):
		row = next(r for r in cf._field_spec()["Warehouse"] if r["fieldname"] == "custom_heat_style")
		self.assertEqual(row["fieldtype"], "Select")
		self.assertEqual([o for o in row["options"].split("\n") if o], ["Smear", "Solid"])


class TestTrapUnitDb(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.sql("INSERT INTO `tabFarm` (name) VALUES (%s)", (FARM,))
		for wh in (BLOCK, OTHER):
			frappe.db.sql("INSERT INTO `tabWarehouse` (name, warehouse_name, custom_farm) VALUES (%s, %s, %s)", (wh, wh, FARM))
		frappe.db.sql("INSERT INTO `tabBed` (name, greenhouse, bed, unit_type) VALUES (%s, %s, 1, 'Row')", (f"{BLOCK} - Row 1", BLOCK))
		for n in (1, 2, 3):
			ring = [[x + 0.0001 * n, y] for x, y in HEX]
			frappe.db.sql(
				"INSERT INTO `tabTriad` (name, block, `row`, triad, farm, geojson) VALUES (%s, %s, %s, %s, %s, %s)",
				(f"{BLOCK} - Row 1 - Triad {n}", BLOCK, f"{BLOCK} - Row 1", n, FARM, feature({"type": "Polygon", "coordinates": [ring]})),
			)
		frappe.db.sql(
			"INSERT INTO `tabOrchard Tree` (name, block, triad, farm, geojson) VALUES (%s, %s, %s, %s, %s)",
			(f"{BLOCK} - Tree 1", BLOCK, f"{BLOCK} - Row 1 - Triad 2", FARM, feature({"type": "Point", "coordinates": [36.5, 0.5]})),
		)
		frappe.db.sql(
			"INSERT INTO `tabOrchard Tree` (name, block, triad, farm) VALUES (%s, %s, %s, %s)",
			(f"{BLOCK} - Tree 2", BLOCK, f"{BLOCK} - Row 1 - Triad 3", FARM),
		)

	def tearDown(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")

	def trap(self, num, unit_type="", unit="", geojson=None, station=BLOCK):
		name = f"{FARM} - {num}"
		frappe.db.sql(
			"""INSERT INTO `tabTrap` (name, farm, greenhouse, trap_number, location, unit_type, unit, geojson)
			   VALUES (%s, %s, %s, %s, 'Outdoor', %s, %s, %s)""",
			(name, FARM, station, str(num), unit_type, unit, geojson),
		)
		return name

	def test_triad_unit_geometry_is_the_hexagon(self):
		g = TU.unit_geometry("Triad", f"{BLOCK} - Row 1 - Triad 1")
		self.assertEqual(g["type"], "Polygon")

	def test_tree_unit_is_its_point_else_its_hexagon(self):
		self.assertEqual(TU.unit_geometry("Orchard Tree", f"{BLOCK} - Tree 1"), {"type": "Point", "coordinates": [36.5, 0.5]})
		self.assertEqual(TU.unit_geometry("Orchard Tree", f"{BLOCK} - Tree 2")["type"], "Polygon")

	def test_bed_unit_is_a_line_through_its_hexagons(self):
		g = TU.unit_geometry("Bed", f"{BLOCK} - Row 1")
		self.assertEqual(g["type"], "LineString")
		self.assertEqual(len(g["coordinates"]), 3)
		xs = [p[0] for p in g["coordinates"]]
		self.assertEqual(xs, sorted(xs))

	def test_missing_unit_has_no_geometry(self):
		self.assertIsNone(TU.unit_geometry("Triad", "_TEST nope"))
		self.assertIsNone(TU.unit_geometry("Zone", f"{BLOCK} - Row 1"))

	def test_locations_put_a_unit_trap_on_its_unit(self):
		t = self.trap(1, "Triad", f"{BLOCK} - Row 1 - Triad 1",
		              geojson=json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [10.0, 10.0]}}]}))
		out = TL.get_trap_locations(farm=FARM)[t]
		self.assertEqual(out["unit_type"], "Triad")
		self.assertEqual(out["unit"], f"{BLOCK} - Row 1 - Triad 1")
		self.assertEqual(out["unit_geometry"]["type"], "Polygon")
		self.assertEqual(out["trap_number"], "1")
		self.assertEqual(out["source"], "Unit")
		# the unit wins over the trap's own point
		self.assertLess(abs(out["lng"] - 36.0001), 0.001)

	def test_locations_fall_back_to_geojson_and_list_unit_only_traps(self):
		pt = json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [36.7, 0.7]}}]})
		plain = self.trap(2, geojson=pt)
		unit_only = self.trap(3, "Orchard Tree", f"{BLOCK} - Tree 1")
		nowhere = self.trap(4)
		out = TL.get_trap_locations(farm=FARM)
		self.assertEqual((out[plain]["lat"], out[plain]["lng"]), (0.7, 36.7))
		self.assertIsNone(out[plain]["unit_geometry"])
		self.assertEqual((out[unit_only]["lat"], out[unit_only]["lng"]), (0.5, 36.5))
		self.assertNotIn(nowhere, out)

	def test_validation_keeps_the_unit_in_the_station(self):
		doc = frappe.get_doc({"doctype": "Trap", "farm": FARM, "greenhouse": OTHER, "trap_number": "9",
		                      "unit_type": "Triad", "unit": f"{BLOCK} - Row 1 - Triad 1"})
		with self.assertRaises(frappe.ValidationError):
			TU.validate_trap_unit(doc)
		doc.greenhouse = None
		TU.validate_trap_unit(doc)
		self.assertEqual(doc.greenhouse, BLOCK)
		doc.unit_type = ""
		with self.assertRaises(frappe.ValidationError):
			TU.validate_trap_unit(doc)

	def test_set_trap_unit_endpoint_returns_the_geometry(self):
		t = self.trap(5)
		out = TU.set_trap_unit(t, "Triad", f"{BLOCK} - Row 1 - Triad 2")
		self.assertEqual(frappe.db.get_value("Trap", t, ["unit_type", "unit"]), ("Triad", f"{BLOCK} - Row 1 - Triad 2"))
		self.assertEqual(out["unit_geometry"]["type"], "Polygon")
		self.assertIsNotNone(out["lat"])
		cleared = TU.set_trap_unit(t)
		self.assertFalse(frappe.db.get_value("Trap", t, "unit"))
		self.assertIsNone(cleared["unit_geometry"])

	def test_mobile_trap_list_carries_the_unit(self):
		from upande_scp.serverscripts.mobile.create_scouting_entry import fetchTraps

		self.trap(6, "Bed", f"{BLOCK} - Row 1")
		fetchTraps(greenhouse=BLOCK)
		rows = frappe.response["data"]
		row = next(r for r in rows if r["trap_number"] == "6")
		self.assertEqual((row["unit_type"], row["unit"]), ("Bed", f"{BLOCK} - Row 1"))
