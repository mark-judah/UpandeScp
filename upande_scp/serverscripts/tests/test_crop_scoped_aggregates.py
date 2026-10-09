"""Overview + Trends honour D4/D5 and the route crop. DB test — direct runner."""

import unittest

import frappe

from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.tests import crop_scoping_fixture as F

FROM, TO = F.WEEK_A
AVOCADO_PEST = "Fruit fly (Ceratitis)"   # Avocado Pest Filter only
AVOCADO_DISEASE = "Avocado Scab"         # Avocado Disease Filter only


def _overview(crop, force="1"):
    kw = {"from_date": FROM, "to_date": TO, "crop": crop}
    if force:
        kw["force"] = force
    return DA.overview(**kw)


class TestCropScopedAggregates(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()

    def tearDown(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        frappe.db.rollback()

    def test_a_crop_less_entry_counts_once_under_its_greenhouse_crop(self):
        F.insert_entry(greenhouse=self.gh, crop=None, date=FROM, pests=["Thrips"])
        rose = _overview("Rose")
        self.assertEqual(rose["kpis"]["zonesScouted"], 1)
        self.assertEqual(rose["rangeTotals"]["pests"], 1)
        self.assertEqual(_overview("Avocado")["kpis"]["zonesScouted"], 0)

    def test_off_crop_children_are_excluded(self):
        F.insert_entry(greenhouse=self.gh, crop="Rose", date=FROM,
                       pests=["Thrips", AVOCADO_PEST], diseases=["Powdery Mildew", AVOCADO_DISEASE])
        totals = _overview("Rose")["rangeTotals"]
        self.assertEqual((totals["pests"], totals["diseases"]), (1, 1))

    def test_trends_options_are_crop_only(self):
        F.insert_entry(greenhouse=self.gh, crop="Rose", date=FROM,
                       pests=["Thrips", AVOCADO_PEST], diseases=["Powdery Mildew", AVOCADO_DISEASE])
        opts = DA.trends(from_date=FROM, to_date=TO, crop="Rose", force="1")["options"]
        self.assertEqual(set(opts["pests"]), {"Thrips"})
        self.assertEqual(set(opts["diseases"]), {"Powdery Mildew"})

    def test_a_clean_crop_less_entry_is_in_the_trends_denominator(self):
        F.insert_entry(greenhouse=self.gh, crop=None, date=FROM)
        rose = DA.trends(from_date=FROM, to_date=TO, crop="Rose", force="1")
        self.assertIn(self.gh, rose["vocab"]["stations"])
        avo = DA.trends(from_date=FROM, to_date=TO, crop="Avocado", force="1")
        self.assertNotIn(self.gh, avo["vocab"]["stations"])

    def test_one_crops_payload_is_not_served_to_another(self):
        F.insert_entry(greenhouse=self.gh, crop="Rose", date=FROM, pests=["Thrips"])
        self.assertEqual(_overview("Rose")["kpis"]["zonesScouted"], 1)
        # Not forced: must read Avocado's own key, never Rose's.
        self.assertEqual(_overview("Avocado", force=None)["kpis"]["zonesScouted"], 0)

    def test_a_lowercase_route_crop_shares_the_canonical_cache_entry(self):
        F.insert_entry(greenhouse=self.gh, crop="Rose", date=FROM, pests=["Thrips"])
        seen = []
        real = DA._overview.__globals__["cached_aggregate"]

        def spy(endpoint, filters, compute, force=False):
            seen.append(filters.get("crop"))
            return real(endpoint, filters, compute, force)

        from unittest import mock
        with mock.patch.dict(DA._overview.__globals__, {"cached_aggregate": spy}):
            self.assertEqual(_overview("rose")["kpis"]["zonesScouted"], 1)
        self.assertEqual(seen, ["Rose"])

    def test_an_unknown_crop_is_refused(self):
        with self.assertRaises(frappe.PermissionError):
            _overview("Mango")

    def test_a_rose_only_user_is_refused_avocado_aggregates(self):
        if not frappe.db.exists("Employee", {"user_id": F.PETER}):
            self.skipTest("Peter Kamuren has no Employee record on this site")
        frappe.set_user(F.PETER)
        with self.assertRaises(frappe.PermissionError):
            _overview("Avocado")

    def test_no_crop_keeps_todays_unfiltered_behaviour(self):
        F.insert_entry(greenhouse=self.gh, crop=None, date=FROM, pests=[AVOCADO_PEST])
        F.insert_entry(block=F.avocado_block(), crop="Avocado", date=FROM, pests=[AVOCADO_PEST])
        all_crops = _overview("")
        self.assertEqual(all_crops["kpis"]["zonesScouted"], 2)
        self.assertEqual(all_crops["rangeTotals"]["pests"], 2)
