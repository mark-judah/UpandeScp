import unittest
from unittest import mock

from upande_scp.upande_scp.doctype.spray_plan_settings import spray_plan_settings as sps


WAREHOUSES = [
    "Chemical Main Store - MFK",
    "Fertilizer Main Store - MFK",
    "General Main Store - MFK",
    "Main CSU - MFK",
    "Main CSU A - MFK",
]


class TestAllowedStoreWarehouses(unittest.TestCase):
    def test_chemical_store_matched(self):
        with mock.patch.object(sps, "get_allowed_farms", return_value=["Main"]), \
             mock.patch.object(sps.frappe, "get_all", return_value=list(WAREHOUSES)):
            self.assertEqual(
                sps.get_allowed_chemical_store_warehouses(),
                ["Chemical Main Store - MFK"],
            )

    def test_fertilizer_store_matched(self):
        with mock.patch.object(sps, "get_allowed_farms", return_value=["Main"]), \
             mock.patch.object(sps.frappe, "get_all", return_value=list(WAREHOUSES)):
            self.assertEqual(
                sps.get_allowed_fertilizer_unit_warehouses(),
                ["Fertilizer Main Store - MFK"],
            )

    def test_no_farms_returns_empty(self):
        with mock.patch.object(sps, "get_allowed_farms", return_value=[]):
            self.assertEqual(sps.get_allowed_chemical_store_warehouses(), [])
