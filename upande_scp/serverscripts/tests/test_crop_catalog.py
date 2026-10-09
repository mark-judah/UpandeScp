"""crop_catalog against kaitet.local. DB test — direct runner, rolled back."""

import unittest

import frappe

from upande_scp.serverscripts.common import crop_catalog as CC
from upande_scp.serverscripts.common import crop_scope

PETER = "pkamuren@karenroses.com"  # SCP General Manager at Karen Roses: Rose only


def _rose_greenhouse():
    farms = [r[0] for r in frappe.db.sql(
        "select farm from `tabFarm Filter` where parenttype='Crop Scouted' and parent='Rose'")]
    return frappe.db.sql(
        """select name from `tabWarehouse` where custom_farm in %(f)s and is_group=0
           and warehouse_type='Greenhouse' and disabled=0 order by name limit 1""",
        {"f": tuple(farms)})[0][0]


def _avocado_block():
    return frappe.db.sql(
        """select name from `tabWarehouse` where custom_farm='Lokitela' and is_group=0
           and warehouse_type='Block' and disabled=0 order by name limit 1""")[0][0]


class TestCropCatalog(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        CC.invalidate_catalog()

    def tearDown(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        CC.invalidate_catalog()
        frappe.db.rollback()

    def test_lists_come_from_the_filter_rows(self):
        rose = frappe.db.sql("select count(distinct pest) from `tabPest Filter` where crop_scouted='Rose'")[0][0]
        self.assertEqual(len(CC.pests_for_crop("Rose")), rose)
        self.assertIn("Thrips", CC.pests_for_crop("Rose"))
        self.assertIn("Avocado Scab", CC.diseases_for_crop("Avocado"))
        self.assertNotIn("Avocado Scab", CC.diseases_for_crop("Rose"))
        self.assertEqual(
            CC.targets_for_crop("Rose"),
            sorted(set(CC.pests_for_crop("Rose")) | set(CC.diseases_for_crop("Rose"))),
        )

    def test_crop_of_a_greenhouse_and_a_block(self):
        self.assertEqual(CC.crop_for_greenhouse(_rose_greenhouse()), "Rose")
        self.assertEqual(CC.crop_for_greenhouse(_avocado_block()), "Avocado")
        self.assertIsNone(CC.crop_for_greenhouse("Nowhere"))
        self.assertIsNone(CC.crop_for_greenhouse(""))

    def test_greenhouses_follow_the_farms(self):
        gh = _rose_greenhouse()
        self.assertIn(gh, CC.greenhouses_for_crop("Rose"))
        self.assertNotIn(gh, CC.greenhouses_for_crop("Avocado"))
        self.assertIn(_avocado_block(), CC.greenhouses_for_crop("Avocado"))

    def test_resolve_crop_canonicalises(self):
        self.assertEqual(CC.resolve_crop("rose"), "Rose")
        self.assertEqual(CC.resolve_crop(""), "")
        self.assertEqual(CC.resolve_crop(None), "")

    def test_an_unknown_crop_is_refused(self):
        with self.assertRaises(frappe.PermissionError):
            CC.resolve_crop("Mango")

    def test_a_rose_only_user_cannot_resolve_avocado(self):
        if not frappe.db.exists("Employee", {"user_id": PETER}):
            self.skipTest("Peter Kamuren has no Employee record on this site")
        self.assertEqual(CC.resolve_crop("Rose", PETER), "Rose")
        with self.assertRaises(frappe.PermissionError):
            CC.resolve_crop("Avocado", PETER)

    def test_crop_less_entry_on_an_avocado_block_counts_under_avocado_only(self):
        block = _avocado_block()
        row = {"crop_scouted": "", "greenhouse": "", "block": block}
        sql = (
            "select count(*) from (select %(crop_scouted)s crop_scouted, %(greenhouse)s greenhouse, "
            "%(block)s block) se where " + CC.entry_crop_condition("se")
        )
        for crop, expected in (("Avocado", 1), ("Rose", 0)):
            params = {**row, **CC.crop_sql_params(crop)}
            self.assertEqual(frappe.db.sql(sql, params)[0][0], expected, crop)

    def test_the_index_is_not_built_through_permissions(self):
        """A restricted user warming the cache must not shrink it for everyone."""
        if not frappe.db.exists("Employee", {"user_id": PETER}):
            self.skipTest("Peter Kamuren has no Employee record on this site")
        frappe.set_user(PETER)
        CC.invalidate_catalog()
        CC.catalog()
        frappe.set_user("Administrator")
        self.assertEqual(set(CC.catalog()["crops"]), {"Rose", "Avocado", "Coffee"})
        self.assertTrue(CC.pests_for_crop("Avocado"))
