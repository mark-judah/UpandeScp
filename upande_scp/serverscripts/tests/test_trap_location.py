"""Trap fixed locations from GPS fixes — the DB side.

Fixture rows are raw-inserted and rolled back after every test."""

import json
import math
import unittest

import frappe

from upande_scp.serverscripts.traps import trap_location as TL
from upande_scp.serverscripts.traps import trap_geometry as G

FARM = "_TEST TrapLoc Farm"
GH = "_TEST TrapLoc GH"
LAT0, LNG0 = 0.0680, 35.7540
M = 1 / 111195.0


def pt(dx=0.0, dy=0.0):
    return LAT0 + dy * M, LNG0 + dx * M / math.cos(math.radians(LAT0))


class TestTrapLocation(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self._n = 0
        # The house: one bed line running north–south through the origin.
        a, b = pt(0, -20), pt(0, 20)
        frappe.db.sql(
            "INSERT INTO `tabZone` (name, greenhouse, geojson) VALUES (%s, %s, %s)",
            ("_TEST TrapLoc Zone", GH, json.dumps({"type": "FeatureCollection", "features": [{
                "type": "Feature", "properties": {},
                "geometry": {"type": "LineString", "coordinates": [[a[1], a[0]], [b[1], b[0]]]}}]})),
        )

    def tearDown(self):
        frappe.db.rollback()
        frappe.set_user("Administrator")

    def trap(self, num, location="Indoor", source=None, geojson=None):
        name = f"{FARM} - {num}"
        frappe.db.sql(
            """INSERT INTO `tabTrap` (name, farm, greenhouse, trap_number, location,
                   location_source, geojson) VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (name, FARM, GH, str(num), location, source, geojson),
        )
        return name

    def entry(self, traps, dx=0.0, dy=0.0, acc=2.0):
        self._n += 1
        se = f"_TEST-TRAPLOC-SE-{self._n}"
        frappe.db.sql("INSERT INTO `tabScouting Entry` (name, docstatus) VALUES (%s, 0)", (se,))
        for i, t in enumerate(traps):
            frappe.db.sql(
                """INSERT INTO `tabTrap Scouting Entry` (name, parent, parenttype, parentfield, idx, trap, count)
                   VALUES (%s, %s, 'Scouting Entry', 'trap_scouting_entry', %s, %s, 1)""",
                (f"{se}-t{i}", se, i + 1, t),
            )
        lat, lng = pt(dx, dy)
        frappe.db.sql(
            """INSERT INTO `tabScouting Entry Metadata` (name, scouting_entry, latitude, longitude, gps_accuracy)
               VALUES (%s, %s, %s, %s, %s)""",
            (f"{se}-m", se, str(lat), str(lng), str(acc)),
        )

    def test_places_trap_from_single_trap_entries(self):
        t = self.trap(1)
        for dx in (0, 1, -1, 0.5):
            self.entry([t], dx=dx)
        s = TL.run_estimate(farm=FARM, dry_run=False)
        self.assertEqual(s["placed"], 1)
        row = frappe.db.get_value("Trap", t, ["geojson", "location_source", "location_fixes", "location_flag"], as_dict=True)
        self.assertEqual(row.location_source, "GPS estimate")
        self.assertEqual(row.location_fixes, 4)
        self.assertEqual(row.location_flag, "")
        lat, lng = G.point_of(row.geojson)
        self.assertLess(G.distance_m(lat, lng, LAT0, LNG0), 1.0)
        # second run with the same fixes writes nothing new
        self.assertEqual(TL.run_estimate(farm=FARM, dry_run=False)["unchanged"], 1)

    def test_multi_trap_entries_excluded(self):
        a, b = self.trap(2), self.trap(3)
        for _ in range(5):
            self.entry([a, b], dx=3)       # ambiguous: two traps, one fix
        for dx in (10, 11, 12):
            self.entry([a], dx=dx)
        s = TL.run_estimate(farm=FARM, dry_run=False)
        self.assertEqual(frappe.db.get_value("Trap", a, "location_fixes"), 3)
        lat, lng = G.point_of(frappe.db.get_value("Trap", a, "geojson"))
        self.assertAlmostEqual(G.distance_m(lat, lng, *pt(11)), 0.0, delta=0.05)
        self.assertFalse(frappe.db.get_value("Trap", b, "geojson"))
        self.assertEqual(s["no_fixes"], 1)

    def test_too_few_and_inaccurate(self):
        t = self.trap(4)
        self.entry([t]); self.entry([t]); self.entry([t], acc=8.0)
        s = TL.run_estimate(farm=FARM, dry_run=False)
        self.assertEqual(s["skipped_too_few"], 1)
        self.assertFalse(frappe.db.get_value("Trap", t, "geojson"))

    def test_manual_never_overwritten(self):
        manual = json.dumps(G.to_geojson(*pt(5, 5)))
        t = self.trap(5, source="Manual", geojson=manual)
        for dx in (0, 1, 2):
            self.entry([t], dx=dx)
        s = TL.run_estimate(farm=FARM, dry_run=False)
        self.assertEqual(s["unchanged_manual"], 1)
        self.assertEqual(frappe.db.get_value("Trap", t, "geojson"), manual)

    def test_flags_outside_house(self):
        indoor = self.trap(6)
        outdoor_near = self.trap(7, location="Outdoor")
        outdoor_far = self.trap(8, location="Outdoor")
        for t, dx in ((indoor, 50), (outdoor_near, 50), (outdoor_far, 150)):
            for j in range(3):
                self.entry([t], dx=dx + j * 0.2)
        s = TL.run_estimate(farm=FARM, dry_run=False)
        self.assertEqual(frappe.db.get_value("Trap", indoor, "location_flag"), "outside house")
        self.assertEqual(frappe.db.get_value("Trap", outdoor_near, "location_flag"), "")
        self.assertEqual(frappe.db.get_value("Trap", outdoor_far, "location_flag"), "outside house")
        self.assertEqual(s["flagged"], 2)
        self.assertEqual(s["flagged_traps"][0]["trap"], outdoor_far)

    def test_dry_run_writes_nothing(self):
        t = self.trap(9)
        for dx in (0, 1, 2):
            self.entry([t], dx=dx)
        s = TL.estimate_trap_locations(farm=FARM)  # dry_run defaults on
        self.assertTrue(s["dry_run"])
        self.assertEqual(s["placed"], 1)
        self.assertFalse(frappe.db.get_value("Trap", t, "geojson"))

    def test_permission_refused(self):
        user = "_test_traploc_scout@example.com"
        frappe.db.sql("INSERT INTO `tabUser` (name, email, first_name, enabled, user_type) VALUES (%s, %s, 'T', 1, 'System User')", (user, user))
        frappe.set_user(user)
        with self.assertRaises(frappe.PermissionError):
            TL.estimate_trap_locations(farm=FARM, dry_run=0)

    def test_form_edit_marks_manual(self):
        t = self.trap(10, source="GPS estimate")
        doc = frappe.get_doc("Trap", t)
        doc.geojson = json.dumps(G.to_geojson(*pt(1, 1)))
        doc.run_method("validate")
        self.assertEqual(doc.location_source, "Manual")

    def test_get_trap_locations(self):
        t = self.trap(11)
        for dx in (0, 1, 2):
            self.entry([t], dx=dx)
        TL.run_estimate(farm=FARM, dry_run=False)
        out = TL.get_trap_locations(farm=FARM)
        self.assertIn(t, out)
        self.assertEqual(out[t]["source"], "GPS estimate")
        self.assertEqual(out[t]["fixes"], 3)
