"""Spray-plan bootstrap / diagnose / validation by crop. DB test — direct runner."""

import unittest
from unittest.mock import patch

import frappe
from frappe.utils import today

from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.spray_plan_creator import bootstrap as B
from upande_scp.serverscripts.spray_plan_creator import drafts as D
from upande_scp.serverscripts.spray_plan_creator.validation import validate_targets_in_scope
from upande_scp.serverscripts.tests import crop_scoping_fixture as F

FROM, TO = F.WEEK_D
AVOCADO_PEST = "Fruit fly (Ceratitis)"
AVOCADO_DISEASE = "Avocado Scab"


class TestBootstrapByCrop(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        F.add_creator_roster("Chepsito")
        F.add_creator_roster("Lokitela")

    def tearDown(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        frappe.db.rollback()
        crop_catalog.invalidate_catalog()

    def test_rose_lists_no_avocado_farm_block_or_target(self):
        b = B.fetch_creator_bootstrap(crop="rose")
        rose_farms = crop_scope.farms_for_crop("Rose")
        self.assertIn("Chepsito", b["scope"]["farms"])
        self.assertNotIn("Lokitela", b["scope"]["farms"])
        self.assertTrue(all(g["custom_farm"] in rose_farms for g in b["greenhouses"]))
        self.assertTrue(all(x["custom_farm"] in rose_farms for x in b["blocks"]))
        self.assertEqual([p["name"] for p in b["pest_catalog"]], sorted(crop_catalog.pests_for_crop("Rose")))
        self.assertNotIn(AVOCADO_DISEASE, [d["name"] for d in b["disease_catalog"]])
        farms = set(b["scope"]["farms"])
        self.assertTrue(all(not t.get("custom_farm") or t["custom_farm"] in farms for t in b["tank_mixes"]))
        self.assertLessEqual(set(b["farm_stores"]), farms)

    def test_avocado_lists_lokitela_blocks_only(self):
        b = B.fetch_creator_bootstrap(crop="Avocado")
        self.assertEqual(b["scope"]["farms"], ["Lokitela"])
        self.assertTrue(b["blocks"])
        self.assertTrue(all(x["custom_farm"] == "Lokitela" for x in b["blocks"]))
        self.assertIn(AVOCADO_DISEASE, [d["name"] for d in b["disease_catalog"]])

    def test_no_crop_keeps_the_full_catalog(self):
        b = B.fetch_creator_bootstrap()
        self.assertEqual(len(b["pest_catalog"]), frappe.db.count("Pest"))

    def test_a_crop_with_no_pests_offers_none(self):
        with patch.object(crop_catalog, "pests_for_crop", return_value=[]):
            b = B.fetch_creator_bootstrap(crop="Rose")
        self.assertEqual(b["pest_catalog"], [])

    def test_a_rose_only_user_cannot_bootstrap_avocado(self):
        if not frappe.db.exists("Employee", {"user_id": F.PETER}):
            self.skipTest("Peter Kamuren has no Employee record on this site")
        frappe.set_user(F.PETER)
        with self.assertRaises(frappe.PermissionError):
            B.fetch_creator_bootstrap(crop="Avocado")


class TestDiagnoseAndValidation(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()

    def tearDown(self):
        crop_scope.clear_cache()
        frappe.db.rollback()
        crop_catalog.invalidate_catalog()

    def test_diagnose_takes_the_crop_from_the_greenhouse(self):
        F.insert_entry(greenhouse=self.gh, crop="Rose", date=FROM,
                       pests=["Thrips", AVOCADO_PEST], diseases=[AVOCADO_DISEASE])
        F.insert_entry(greenhouse=self.gh, crop=None, date=FROM, pests=["Aphids"])
        # The client's crop is ignored when the greenhouse names one.
        out = DA.application_plan_diagnose(greenhouse=self.gh, from_date=FROM, to_date=TO,
                                           crop="Avocado", force="1")
        self.assertEqual(out["targets"], ["Aphids", "Thrips"])
        self.assertEqual(out["filterOpts"]["pests"], ["Aphids", "Thrips"])

    def test_a_rose_only_user_cannot_diagnose_an_avocado_block(self):
        if not frappe.db.exists("Employee", {"user_id": F.PETER}):
            self.skipTest("Peter Kamuren has no Employee record on this site")
        frappe.set_user(F.PETER)
        try:
            with self.assertRaises(frappe.PermissionError):
                DA.application_plan_diagnose(greenhouse=F.avocado_block(), from_date=FROM,
                                             to_date=TO, force="1")
        finally:
            frappe.set_user("Administrator")

    def test_preventive_rejects_an_off_crop_target(self):
        with self.assertRaises(frappe.ValidationError) as cm:
            validate_targets_in_scope("Preventive", [AVOCADO_DISEASE], greenhouse=self.gh, crop="Rose")
        self.assertIn("Rose", str(cm.exception))
        validate_targets_in_scope("Preventive", ["Thrips"], greenhouse=self.gh, crop="Rose")

    def test_curative_needs_observed_and_on_crop(self):
        F.insert_entry(greenhouse=self.gh, crop="Rose", date=today(), pests=["Thrips", AVOCADO_PEST])
        validate_targets_in_scope("Curative", ["Thrips"], greenhouse=self.gh, crop="Rose")
        with self.assertRaises(frappe.ValidationError) as cm:
            validate_targets_in_scope("Curative", [AVOCADO_PEST], greenhouse=self.gh, crop="Rose")
        self.assertIn("Rose", str(cm.exception))

    def test_no_crop_keeps_the_catalog_check(self):
        validate_targets_in_scope("Preventive", [AVOCADO_DISEASE], greenhouse="Nowhere", crop=None)

    def test_saving_a_draft_uses_the_greenhouse_crop(self):
        payload = {
            "custom_classification": "Preventive",
            "custom_preventive_reason": "Routine cover ahead of the long rains.",
            "custom_targets": [AVOCADO_DISEASE],
            "custom_greenhouse": self.gh,
            "_skip_bom_validation": 1,
            "chemicals": [{"item_code": "X", "application_rate": 1}],
            "custom_water_volume": 100,
        }
        with self.assertRaises(frappe.ValidationError) as cm:
            D._validate_payload(payload, {})
        self.assertIn("Rose", str(cm.exception))
