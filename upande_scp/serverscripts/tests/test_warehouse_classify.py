import unittest

from upande_scp.serverscripts.warehouse_classify import (
    is_chemical_store,
    is_fertilizer_store,
    is_csu,
)


class TestWarehouseClassify(unittest.TestCase):
    def test_chemical_store_variants(self):
        self.assertTrue(is_chemical_store("Chemical Main Store - MFK"))
        self.assertTrue(is_chemical_store("Chemical Store - ABC"))
        self.assertFalse(is_chemical_store("Fertilizer Main Store - MFK"))
        self.assertFalse(is_chemical_store("Main CSU A - MFK"))
        self.assertFalse(is_chemical_store(""))
        self.assertFalse(is_chemical_store(None))

    def test_fertilizer_store_variants(self):
        self.assertTrue(is_fertilizer_store("Fertilizer Main Store - MFK"))
        self.assertFalse(is_fertilizer_store("Chemical Main Store - MFK"))
        self.assertFalse(is_fertilizer_store("Main CSU B - MFK"))

    def test_csu(self):
        self.assertTrue(is_csu("Main CSU - MFK"))
        self.assertTrue(is_csu("Main CSU A - MFK"))
        self.assertFalse(is_csu("Chemical Main Store - MFK"))
