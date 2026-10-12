"""get_scout_images maps Employee id -> photo URL, only for Employees with one.

Rows are written inside a transaction and rolled back; the cache is bypassed by
calling the builder directly.
"""

import unittest

import frappe

from upande_scp.serverscripts.scouting import scouting_metrics_api as API


class TestScoutImages(unittest.TestCase):
    def setUp(self):
        frappe.db.begin()

    def tearDown(self):
        frappe.db.rollback()

    def test_only_employees_with_a_photo_are_returned(self):
        emps = frappe.get_all("Employee", filters={"status": "Active"}, pluck="name", limit=2)
        if len(emps) < 2:
            self.skipTest("need two active employees")
        with_photo, without = emps
        frappe.db.set_value("Employee", with_photo, "image", "/files/test-scout.png", update_modified=False)
        frappe.db.set_value("Employee", without, "image", "", update_modified=False)
        out = API._build_scout_images()
        self.assertEqual(out.get(with_photo), "/files/test-scout.png")
        self.assertNotIn(without, out)
