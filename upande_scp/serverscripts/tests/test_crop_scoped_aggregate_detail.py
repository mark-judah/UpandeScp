"""Pests/Diseases tabs, greenhouse detail and heatmaps honour D4/D5. DB test."""

import unittest

import frappe

from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.dashboard_aggregates import _heatmaps as H
from upande_scp.serverscripts.dashboard_aggregates._trends import week_key
from upande_scp.serverscripts.tests import crop_scoping_fixture as F

FROM, TO = F.WEEK_B
AVOCADO_PEST = "Fruit fly (Ceratitis)"
AVOCADO_DISEASE = "Avocado Scab"


class TestCropScopedDetail(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()
        F.insert_entry(greenhouse=self.gh, crop="Rose", date=FROM,
                       pests=["Thrips", AVOCADO_PEST], diseases=["Powdery Mildew", AVOCADO_DISEASE])
        self.bare = F.insert_entry(greenhouse=self.gh, crop=None, date="2031-01-15", pests=["Aphids"])
        # a bed only the crop-less entry scouted, so coverage proves it is counted
        frappe.db.sql("update `tabScouting Entry` set bed=%s, zone=%s where name=%s",
                      (f"{self.gh} - Bed 2", f"{self.gh} - Bed 2 - Zone 1", self.bare))

    def tearDown(self):
        crop_scope.clear_cache()
        frappe.db.rollback()
        crop_catalog.invalidate_catalog()

    def test_pests_tab_offers_only_the_crops_pests(self):
        out = DA.pests(from_date=FROM, to_date=TO, crop="Rose", force="1")
        self.assertEqual(out["filterOptions"]["pests"], ["Aphids", "Thrips"])

    def test_diseases_tab_offers_only_the_crops_diseases(self):
        out = DA.diseases(from_date=FROM, to_date=TO, crop="Rose", force="1")
        self.assertEqual(out["filterOptions"]["diseases"], ["Powdery Mildew"])

    def test_greenhouse_detail(self):
        rose = DA.greenhouse_detail(greenhouse=self.gh, from_date=FROM, to_date=TO, crop="Rose", force="1")
        self.assertEqual({p["name"] for p in rose["topPests"]}, {"Thrips", "Aphids"})
        self.assertEqual({d["name"] for d in rose["topDiseases"]}, {"Powdery Mildew"})
        avo = DA.greenhouse_detail(greenhouse=self.gh, from_date=FROM, to_date=TO, crop="Avocado", force="1")
        self.assertEqual(avo["topPests"], [])

    def test_heatmap_cards_are_crop_only(self):
        out = DA.heatmaps_grid(from_date=FROM, to_date=TO, crop="Rose", force="1")
        names = {c["obsName"] for c in out["cards"]}
        self.assertEqual(names, {"Thrips", "Aphids", "Powdery Mildew"})

    def test_latest_scouting_date_sees_crop_less_entries(self):
        self.assertEqual(H._latest_scouting_date("Rose"), "2031-01-15")
        self.assertNotEqual(H._latest_scouting_date("Avocado"), "2031-01-15")

    def test_coverage_counts_crop_less_entries(self):
        cov = H.scouts_and_coverage(self.gh, FROM, TO, "Rose")
        wk = week_key("2031-01-15")
        self.assertIn(wk, cov)
        self.assertEqual(cov[wk]["bedsScouted"], 2)

    def test_coverage_never_passes_100_on_retired_beds(self):
        # Retire every bed of the house: scouted retired beds must not count
        # towards coverage (Simotwo GH 07 read 157.1%), they are reported apart.
        frappe.db.sql("update `tabBed` set custom_active=0 where greenhouse=%s", self.gh)
        frappe.db.sql("update `tabBed` set custom_active=1 where greenhouse=%s and bed=2", self.gh)
        cov = H.scouts_and_coverage(self.gh, FROM, TO, "Rose")
        wk = week_key("2031-01-15")
        self.assertEqual(cov[wk]["bedsScouted"], 1)
        self.assertEqual(cov[wk]["bedsRetiredScouted"], 1)
        self.assertLessEqual(cov[wk]["coveragePct"] or 0, 100.0)
