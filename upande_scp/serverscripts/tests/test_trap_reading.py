"""Latest trap reading with its recorder (spec 2026-10-11 TM4).
DB test — direct runner, rolled back."""

import unittest
from unittest import mock

import frappe

from upande_scp.serverscripts.common import crop_scope
from upande_scp.serverscripts.traps import trap_reading as TR
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests.test_observation_gallery import scouts

FARM = "_TEST TrapRead Farm"


class TestLatestTrapReading(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        self.gh = F.rose_greenhouse()
        self.s1, self.s2 = scouts(2)
        self.trap = "_TEST TrapRead - 1"
        frappe.db.sql(
            "INSERT INTO `tabTrap` (name, farm, greenhouse, trap_number, location) VALUES (%s, %s, %s, '1', 'Indoor')",
            (self.trap, FARM, self.gh),
        )
        self._n = 0

    def tearDown(self):
        frappe.db.rollback()
        frappe.set_user("Administrator")
        crop_scope.clear_cache()

    def reading(self, scout, day, time, count, pest="Thrips", greenhouse=None, trap=None):
        self._n += 1
        se = f"_TEST-TRAPREAD-SE-{self._n}"
        frappe.db.sql(
            """INSERT INTO `tabScouting Entry` (name, docstatus, scouts_name, greenhouse, date_of_capture,
                   time_of_capture, creation) VALUES (%s, 0, %s, %s, %s, %s, NOW())""",
            (se, scout, greenhouse or self.gh, day, time),
        )
        frappe.db.sql(
            """INSERT INTO `tabTrap Scouting Entry` (name, parent, parenttype, parentfield, idx, trap, pest, count)
               VALUES (%s, %s, 'Scouting Entry', 'trap_scouting_entry', 1, %s, %s, %s)""",
            (f"{se}-t", se, trap or self.trap, pest, count),
        )
        return se

    def test_latest_reading_carries_the_recorders_photo(self):
        self.reading(self.s1, "2031-12-01", "08:00:00", 4)
        latest = self.reading(self.s2, "2031-12-02", "14:35:10", 7.0, pest="Whiteflies")
        self.reading(self.s1, "2031-12-02", "09:00:00", 2)
        out = TR.get_latest_trap_reading(self.trap, "2031-12-01", "2031-12-07")
        self.assertEqual(out["entry"], latest)
        self.assertEqual((out["scout"], out["date"], out["time"], out["count"], out["pest"], out["house"]),
                         (self.s2, "2031-12-02", "14:35:10", 7, "Whiteflies", self.gh))
        emp = frappe.db.get_value("Employee", self.s2, ["employee_name", "image"], as_dict=True)
        self.assertEqual((out["scoutName"], out["image"]), (emp.employee_name, emp.image or ""))

    def test_window_bounds_the_reading(self):
        self.reading(self.s1, "2031-12-01", "08:00:00", 4)
        self.reading(self.s2, "2031-12-09", "08:00:00", 9)
        self.assertEqual(TR.get_latest_trap_reading(self.trap, "2031-12-01", "2031-12-07")["count"], 4)
        self.assertEqual(TR.get_latest_trap_reading(self.trap)["count"], 9)
        self.assertIsNone(TR.get_latest_trap_reading(self.trap, "2031-12-20", "2031-12-21")["entry"])

    def test_out_of_scope_trap_is_refused(self):
        self.reading(self.s1, "2031-12-01", "08:00:00", 4)
        with mock.patch.object(crop_scope, "scoped_greenhouses", return_value={"Some Other House"}), \
                mock.patch.object(crop_scope, "scoped_farms", return_value=set()):
            with self.assertRaises(frappe.PermissionError):
                TR.get_latest_trap_reading(self.trap)
        with mock.patch.object(crop_scope, "scoped_greenhouses", return_value={self.gh}):
            self.assertEqual(TR.get_latest_trap_reading(self.trap)["count"], 4)

    def test_unknown_and_blank_trap(self):
        with self.assertRaises(frappe.ValidationError):
            TR.get_latest_trap_reading("")
        with self.assertRaises(frappe.DoesNotExistError):
            TR.get_latest_trap_reading("_TEST no such trap")

    def photo(self, entry, image, subject=None, idx=1):
        frappe.db.sql(
            """INSERT INTO `tabScouting Entry Photo` (name, parent, parenttype, parentfield, idx, image, subject)
               VALUES (%s, %s, 'Scouting Entry', 'photos_scouting_entry', %s, %s, %s)""",
            (f"{entry}-ph{idx}", entry, idx, image, subject),
        )

    def test_trap_photos_carry_scout_pest_and_count(self):
        e1 = self.reading(self.s1, "2031-12-01", "08:00:00", 4)
        e2 = self.reading(self.s2, "2031-12-02", "14:35:10", 7.0, pest="Whiteflies")
        self.photo(e1, "/private/files/a.jpg", "General")
        self.photo(e2, "/private/files/b.jpg", "Whiteflies")
        self.photo(e2, "/private/files/c.jpg", "Powdery Mildew", idx=2)  # not a trap photo
        self.photo(e2, "", None, idx=3)                                  # no picture
        out = TR.trap_photos(self.trap, "2031-12-01", "2031-12-07")
        self.assertEqual([p["image"] for p in out], ["/private/files/b.jpg", "/private/files/a.jpg"])
        p = out[0]
        self.assertEqual((p["entry"], p["scout"], p["count"], p["pest"], p["date"], p["time"]),
                         (e2, self.s2, 7, "Whiteflies", "2031-12-02", "14:35:10"))
        emp = frappe.db.get_value("Employee", self.s2, ["employee_name", "image"], as_dict=True)
        self.assertEqual((p["scout_name"], p["scout_image"]), (emp.employee_name, emp.image or ""))

    def test_trap_photos_window_and_scope(self):
        e = self.reading(self.s1, "2031-12-09", "08:00:00", 4)
        self.photo(e, "/private/files/a.jpg")
        self.assertEqual(TR.trap_photos(self.trap, "2031-12-01", "2031-12-07"), [])
        self.assertEqual(len(TR.trap_photos(self.trap)), 1)
        with mock.patch.object(crop_scope, "scoped_greenhouses", return_value={"Some Other House"}), \
                mock.patch.object(crop_scope, "scoped_farms", return_value=set()):
            with self.assertRaises(frappe.PermissionError):
                TR.trap_photos(self.trap)
        with self.assertRaises(frappe.ValidationError):
            TR.trap_photos("")


if __name__ == "__main__":
    unittest.main()
