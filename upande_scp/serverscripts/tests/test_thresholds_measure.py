"""Thresholds piece 3a: the measure field, its migration and the editor API.
DB test — direct runner. Everything is rolled back in tearDown; save_thresholds
commits, so its calls run with frappe.db.commit patched out."""

import unittest
from unittest.mock import patch

import frappe

from upande_scp.patches.v1_0 import set_threshold_measure as PATCH
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.store import thresholds_api as API


def _row(doctype, crop, field, obs):
    return frappe.db.get_value(doctype, {"crop_scouted": crop, field: obs}, "name")


def _measure(doctype, crop, field, obs):
    return frappe.db.get_value(doctype, _row(doctype, crop, field, obs), "measure")


class TestMeasureMigration(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")

    def tearDown(self):
        frappe.set_user("Administrator")
        _common.clear_threshold_cache()
        frappe.db.rollback()

    def test_the_patch_maps_old_units_to_measures(self):
        PATCH.execute()
        self.assertEqual(_measure("Pest Filter", "Rose", "pest", "Aphids"), "Count")             # Per Warehouse, both stages counted
        self.assertEqual(_measure("Pest Filter", "Avocado", "pest", "FCM"), "Count")
        self.assertEqual(_measure("Pest Filter", "Avocado", "pest", "Caterpillars"), "Count")    # Per Hectare
        self.assertEqual(_measure("Pest Filter", "Rose", "pest", "Spidermites"), "Percentage")   # "Web" is a tick-box stage
        self.assertEqual(_measure("Pest Filter", "Avocado", "pest", "Scale Insects"), "Percentage")
        self.assertEqual(_measure("Pest Filter", "Coffee", "pest", "Antestia Bug"), "Percentage")  # Per Zone %
        self.assertEqual(_measure("Pest Filter", "Rose", "pest", "Thrips"), "Percentage")
        self.assertEqual(set(frappe.get_all("Disease Filter", pluck="measure")), {"Percentage"})

    def test_the_misordered_rose_thrips_row_is_left_as_it_is_and_flagged(self):
        name = _row("Pest Filter", "Rose", "pest", "Thrips")
        frappe.db.set_value("Pest Filter", name, {"low_threshold": 1, "moderate_threshold": 0.4, "high_threshold": 2})
        PATCH.execute()
        bands = frappe.db.get_value("Pest Filter", name, ["low_threshold", "moderate_threshold", "high_threshold"])
        self.assertEqual([float(b) for b in bands], [1.0, 0.4, 2.0])
        thrips = next(p for p in API.get_thresholds("Rose")["pests"] if p["pest"] == "Thrips")
        self.assertTrue(thrips["invalid"])

    def test_wanted_measure_needs_every_stage_counted(self):
        self.assertEqual(PATCH.wanted_measure("Pest Filter", "Per Warehouse", ["Count", "Count"]), "Count")
        self.assertEqual(PATCH.wanted_measure("Pest Filter", "Per Hectare", ["Count"]), "Count")
        self.assertEqual(PATCH.wanted_measure("Pest Filter", "Per Hectare", ["Count", "Checkbox"]), "Percentage")
        self.assertEqual(PATCH.wanted_measure("Pest Filter", "Per Zone %", ["Count"]), "Percentage")
        self.assertEqual(PATCH.wanted_measure("Pest Filter", "Per Warehouse", []), "Percentage")
        self.assertEqual(PATCH.wanted_measure("Disease Filter", "Per Warehouse", ["Count"]), "Percentage")


class TestEditorApi(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.rose = API.get_thresholds("Rose")

    def tearDown(self):
        frappe.set_user("Administrator")
        _common.clear_threshold_cache()
        frappe.db.rollback()

    def _pest(self, name):
        return next(p for p in self.rose["pests"] if p["pest"] == name)

    def test_the_payload_carries_measure_count_allowed_and_reading_types(self):
        thrips = self._pest("Thrips")
        self.assertIn(thrips["measure"], ("Percentage", "Count"))
        self.assertTrue(thrips["count_allowed"])
        self.assertEqual(
            {s["stage"]: s["reading_type"] for s in thrips["stages"]},
            {"Adult": "Count", "Larvae": "Count", "Damages": "Checkbox"},
        )
        self.assertNotIn("unit", thrips)
        self.assertFalse(self._pest("Scale Insects")["count_allowed"])
        self.assertTrue(all(not d["count_allowed"] for d in self.rose["diseases"]))

    def test_the_count_unit_follows_the_crops_stations(self):
        self.assertEqual(self.rose["station"], "zone")
        self.assertEqual(API.get_thresholds("Avocado")["station"], "tree")
        self.assertEqual(_common.station_word("Coffee"), "zone")

    def test_count_is_refused_for_a_tick_box_pest(self):
        scale = dict(self._pest("Scale Insects"), measure="Count")
        with self.assertRaises(frappe.ValidationError) as cm:
            API.save_thresholds("Rose", {"pests": [scale], "diseases": []})
        self.assertIn("Count needs a stage", str(cm.exception))

    def test_count_is_refused_for_a_disease(self):
        disease = dict(self.rose["diseases"][0], measure="Count")
        with self.assertRaises(frappe.ValidationError):
            API.save_thresholds("Rose", {"pests": [], "diseases": [disease]})

    def test_misordered_bands_are_refused_on_the_row_and_on_a_stage(self):
        thrips = self._pest("Thrips")
        bad_row = dict(thrips, measure="Percentage", low=1, moderate=0.4, high=2,
                       stages=[dict(s, low=0, moderate=0, high=0) for s in thrips["stages"]])
        with self.assertRaises(frappe.ValidationError) as cm:
            API.save_thresholds("Rose", {"pests": [bad_row], "diseases": []})
        self.assertIn("bands must rise", str(cm.exception))
        stages = [dict(s, low=5, moderate=5, high=10) if s["stage"] == "Adult" else dict(s, low=0, moderate=0, high=0)
                  for s in thrips["stages"]]
        bad_stage = dict(thrips, measure="Percentage", low=0, moderate=0, high=0, stages=stages)
        with self.assertRaises(frappe.ValidationError) as cm:
            API.save_thresholds("Rose", {"pests": [bad_stage], "diseases": []})
        self.assertIn("Thrips · Adult", str(cm.exception))

    def test_a_refused_save_writes_nothing(self):
        before = float(frappe.db.get_value("Pest Filter", self._pest("Aphids")["row"], "high_threshold") or 0)
        aphids = dict(self._pest("Aphids"), low=1, moderate=2, high=before + 3)
        scale = dict(self._pest("Scale Insects"), measure="Count")
        with self.assertRaises(frappe.ValidationError):
            API.save_thresholds("Rose", {"pests": [aphids, scale], "diseases": []})
        self.assertEqual(float(frappe.db.get_value("Pest Filter", aphids["row"], "high_threshold") or 0), before)

    def test_a_valid_save_stores_measure_and_bands_and_clears_the_flag(self):
        thrips = dict(self._pest("Thrips"), measure="Count", low=0, moderate=1, high=2,
                      stages=[dict(s, low=0, moderate=0, high=0) for s in self._pest("Thrips")["stages"]])
        with patch.object(frappe.db, "commit"):
            API.save_thresholds("Rose", {"pests": [thrips], "diseases": []})
        measure, mod, high = frappe.db.get_value("Pest Filter", thrips["row"], ["measure", "moderate_threshold", "high_threshold"])
        self.assertEqual((measure, float(mod), float(high)), ("Count", 1.0, 2.0))
        self.assertFalse(next(p for p in API.get_thresholds("Rose")["pests"] if p["pest"] == "Thrips")["invalid"])

    def test_all_zero_is_unconfigured_and_allowed(self):
        thrips = dict(self._pest("Thrips"), measure="Percentage", low=0, moderate=0, high=0,
                      stages=[dict(s, low=0, moderate=0, high=0) for s in self._pest("Thrips")["stages"]])
        with patch.object(frappe.db, "commit"):
            out = API.save_thresholds("Rose", {"pests": [thrips], "diseases": []})
        self.assertTrue(out["ok"])

    def test_a_row_without_a_measure_key_keeps_the_stored_measure(self):
        thrips = self._pest("Thrips")
        frappe.db.set_value("Pest Filter", thrips["row"], "measure", "Count")
        old_client = {k: v for k, v in thrips.items() if k != "measure"}
        old_client.update(low=0, moderate=1, high=2)
        with patch.object(frappe.db, "commit"):
            API.save_thresholds("Rose", {"pests": [old_client], "diseases": []})
        self.assertEqual(frappe.db.get_value("Pest Filter", thrips["row"], "measure"), "Count")
