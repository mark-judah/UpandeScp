"""Trap photo requirement (per trap pest): the Traps section of the Scouting tab,
the settings page round trip and the scout app's payload. DB test, rolled back."""

import json
import unittest
from unittest.mock import patch

import frappe

from upande_scp.serverscripts.scouting import capture_settings as CS
from upande_scp.serverscripts.spray_plan_creator import settings as S

SETTINGS = "Scouting and Crop Protection Settings"


def pests(n=2):
    return frappe.get_all("Pest", pluck="name", order_by="name", limit_page_length=n)


class TestTrapPhotoRules(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self._commit = patch.object(frappe.db, "commit").start()
        self.a, self.b = pests()

    def tearDown(self):
        frappe.db.rollback()
        patch.stopall()

    def test_schema_is_a_child_table_on_the_scouting_tab(self):
        meta = frappe.get_meta(SETTINGS)
        order = [f.fieldname for f in meta.fields]
        self.assertEqual(meta.get_field("trap_photo_rules").options, "Trap Photo Rule")
        self.assertGreater(order.index("trap_photos_section"), order.index("scouting_tab"))
        rule = frappe.get_meta("Trap Photo Rule")
        self.assertEqual((rule.get_field("pest").options, rule.get_field("photo_required").fieldtype),
                         ("Pest", "Check"))

    def test_nothing_configured_means_no_photo_required(self):
        self.assertEqual(CS.trap_photo_rules(), {})
        self.assertFalse(CS.trap_photo_required(self.a))
        self.assertEqual(CS.as_payload()["trap_photo_required"], [])

    def test_a_save_round_trips_and_reaches_the_app_payload(self):
        S.save_spray_plan_settings(json.dumps({"trap_photo_rules": [
            {"pest": self.a, "photo_required": 1}, {"pest": self.b, "photo_required": 0},
            {"pest": self.a, "photo_required": 0}, {"pest": "", "photo_required": 1}]}))
        self.assertEqual(CS.trap_photo_rules(), {self.a: True, self.b: False})
        self.assertEqual(CS.as_payload()["trap_photo_required"], [self.a])
        bundle = S.get_settings_bundle()["spray_plan"]
        self.assertEqual({r["pest"]: r["photo_required"] for r in bundle["trap_photo_rules"]},
                         {self.a: 1, self.b: 0})
        self.assertIn(self.a, bundle["trap_pests"])

    def test_other_saves_leave_the_rules_alone(self):
        S.save_spray_plan_settings(json.dumps({"trap_photo_rules": [{"pest": self.a, "photo_required": 1}]}))
        S.save_spray_plan_settings(json.dumps({"loaning_timeout_hours": 24}))
        self.assertTrue(CS.trap_photo_required(self.a))

    def test_the_general_photo_switch_is_independent(self):
        S.save_spray_plan_settings(json.dumps({"allow_scout_photos": 0,
                                               "trap_photo_rules": [{"pest": self.a, "photo_required": 1}]}))
        got = CS.as_payload()
        self.assertFalse(got["photos"])
        self.assertEqual(got["trap_photo_required"], [self.a])


if __name__ == "__main__":
    unittest.main()
