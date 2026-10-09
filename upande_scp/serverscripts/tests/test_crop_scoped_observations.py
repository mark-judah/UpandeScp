"""Observations week slices + farm lists by crop. DB test — direct runner."""

import unittest
from unittest.mock import patch

import frappe

from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.scouting import get_complete_scouting_entries as G
from upande_scp.serverscripts.scouting import scouting_metrics_api as API
from upande_scp.serverscripts.tests import crop_scoping_fixture as F

FROM, TO = F.WEEK_C  # 2031-W04


def _drop_week_keys():
    for crop in (None, "Rose", "Avocado", "Coffee"):
        frappe.cache().delete_value(G._week_cache_key(2031, 4, crop))


class TestCropScopedObservations(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        _drop_week_keys()
        self.gh = F.rose_greenhouse()
        self.rose = F.insert_entry(greenhouse=self.gh, crop="Rose", date=FROM,
                                   pests=["Thrips", "Fruit fly (Ceratitis)"])
        self.crop_less = F.insert_entry(greenhouse=self.gh, crop=None, date=FROM)
        self.avo = F.insert_entry(block=F.avocado_block(), crop="Avocado", date=FROM,
                                  pests=["Fruit fly (Ceratitis)"])

    def tearDown(self):
        _drop_week_keys()
        crop_scope.clear_cache()
        frappe.db.rollback()
        crop_catalog.invalidate_catalog()

    def _names(self, payload):
        return [e["name"] for e in payload["entries"]]

    def test_rose_slice_has_crop_less_rows_once(self):
        names = self._names(G.getScoutingEntriesChunk(from_date=FROM, to_date=TO, crop="rose"))
        self.assertIn(self.rose, names)
        self.assertIn(self.crop_less, names)
        self.assertNotIn(self.avo, names)
        self.assertEqual(len(names), len(set(names)))

    def test_other_crops_pests_are_not_returned(self):
        entries = G.getScoutingEntriesChunk(from_date=FROM, to_date=TO, crop="Rose")["entries"]
        rose = next(e for e in entries if e["name"] == self.rose)
        self.assertEqual([p["pest"] for p in rose["pests"]], ["Thrips"])

    def test_crop_slices_are_cached_per_crop(self):
        G.getScoutingEntriesChunk(from_date=FROM, to_date=TO, crop="Rose")
        names = self._names(G.getScoutingEntriesChunk(from_date=FROM, to_date=TO, crop="Avocado"))
        self.assertEqual(names, [self.avo])

    def test_a_dense_slice_outside_the_window_is_not_cached(self):
        # 2031 is "recent" to the server (future); force the old-week path.
        with patch.object(G, "SPARSE_SLICE_MAX", 0), \
                patch.object(G, "_is_recent_week", return_value=False):
            G.getScoutingEntriesChunk(from_date=FROM, to_date=TO, crop="Rose")
        self.assertIsNone(frappe.cache().get_value(G._week_cache_key(2031, 4, "Rose")))

    def test_an_unknown_crop_is_refused(self):
        with self.assertRaises(frappe.PermissionError):
            G.getScoutingEntriesChunk(from_date=FROM, to_date=TO, crop="Mango")

    def test_farm_lists_follow_the_crop(self):
        rose_farms = set(crop_scope.farms_for_crop("Rose"))
        rose = API.get_farms_and_warehouses("rose")
        self.assertTrue(rose)
        self.assertLessEqual(set(rose), rose_farms)
        self.assertNotIn("Lokitela", rose)
        self.assertEqual(set(API.get_farms_and_warehouses("Avocado")), {"Lokitela"})
        with self.assertRaises(frappe.PermissionError):
            API.get_farms_and_warehouses("Mango")
