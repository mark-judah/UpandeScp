"""Settings → Thresholds is crop-keyed end to end. DB test — the commit at the
bottom of save_thresholds is patched out, so nothing here can persist."""

import unittest
from unittest.mock import patch

import frappe

from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.store import thresholds_api as T


class TestThresholdsCropGuard(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.avo_row = frappe.db.get_value("Pest Filter", {"crop_scouted": "Avocado"}, "name")
        self.rose_row = frappe.db.get_value("Pest Filter", {"crop_scouted": "Rose"}, "name")
        # save_thresholds commits at the end. Before the guard exists (the
        # red run) a save would reach it, so the commit is neutralised for
        # every test and tearDown's rollback always undoes the writes.
        self._no_commit = patch.object(frappe.db, "commit")
        self._no_commit.start()

    def tearDown(self):
        self._no_commit.stop()
        frappe.db.rollback()
        crop_catalog.invalidate_catalog()

    def test_get_thresholds_canonicalises_the_crop(self):
        out = T.get_thresholds("rose")
        self.assertEqual(out["crop"], "Rose")
        rose = set(crop_catalog.pests_for_crop("Rose"))
        self.assertTrue(out["pests"])
        self.assertTrue(all(p["pest"] in rose for p in out["pests"]))

    def test_an_unknown_crop_is_refused(self):
        with self.assertRaises(frappe.PermissionError):
            T.get_thresholds("Mango")

    def test_saving_another_crops_row_is_refused(self):
        before = frappe.db.get_value("Pest Filter", self.avo_row, "high_threshold")
        payload = {"pests": [{"row": self.avo_row, "low": 1, "moderate": 2, "high": 99, "stages": []}],
                   "diseases": []}
        with self.assertRaises(frappe.ValidationError):
            T.save_thresholds("Rose", payload)
        self.assertEqual(frappe.db.get_value("Pest Filter", self.avo_row, "high_threshold"), before)

    def test_a_stage_row_must_sit_under_its_row(self):
        stage = frappe.db.get_value("Pests Stages", {"parenttype": "Pest Filter", "parent": self.avo_row}, "name")
        if not stage:
            self.skipTest("the Avocado pest row has no stage rows on this site")
        payload = {"pests": [{"row": self.rose_row, "low": 0, "moderate": 0, "high": 0,
                              "stages": [{"row": stage, "low": 1, "moderate": 2, "high": 3}]}],
                   "diseases": []}
        with self.assertRaises(frappe.ValidationError):
            T.save_thresholds("Rose", payload)
