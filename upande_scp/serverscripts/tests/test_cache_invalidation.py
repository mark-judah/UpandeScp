import datetime
import unittest
from types import SimpleNamespace
from unittest.mock import patch


class TestResolveScoutingDate(unittest.TestCase):
    def test_parent_row_uses_date_of_capture(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        doc = SimpleNamespace(doctype="Scouting Entry", date_of_capture="2025-05-01")
        self.assertEqual(cu._resolve_scouting_date(doc), datetime.date(2025, 5, 1))

    def test_accepts_date_object(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        doc = SimpleNamespace(
            doctype="Scouting Entry", date_of_capture=datetime.date(2025, 5, 1)
        )
        self.assertEqual(cu._resolve_scouting_date(doc), datetime.date(2025, 5, 1))

    def test_child_row_walks_to_parent(self):
        from unittest.mock import Mock
        from upande_scp.serverscripts.common import cache_utils as cu
        doc = SimpleNamespace(doctype="Pests Scouting Entry", parent="SE-0001")
        # frappe.db is an unbound LocalProxy in a no-site test context, so swap
        # the module attribute directly (reading the original via patch.object
        # would trigger the proxy and raise).
        db = Mock()
        db.get_value.return_value = "2025-05-04"
        orig = cu.frappe.__dict__.get("db")
        cu.frappe.db = db
        try:
            self.assertEqual(cu._resolve_scouting_date(doc), datetime.date(2025, 5, 4))
        finally:
            cu.frappe.db = orig
        db.get_value.assert_called_once_with(
            "Scouting Entry", "SE-0001", "date_of_capture"
        )

    def test_unresolvable_returns_none(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        doc = SimpleNamespace(doctype="Scouting Entry", date_of_capture=None)
        self.assertIsNone(cu._resolve_scouting_date(doc))


class TestInvalidateScoutingWeek(unittest.TestCase):
    def test_deletes_only_the_affected_week_key(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        # 2025-05-01 is ISO week 18 of 2025.
        doc = SimpleNamespace(doctype="Scouting Entry", date_of_capture="2025-05-01")
        with patch.object(cu, "scouting_payload_version", return_value=7), \
             patch.object(cu, "invalidate") as inv, \
             patch.object(cu, "invalidate_scouting_payload") as bump:
            cu.invalidate_scouting_week_for_doc(doc)
            # Derive the prefix from the constant rather than spelling out the
            # key version — bumping K_SCOUTING_PAYLOAD_PREFIX (v2 -> v3 -> …) is
            # a routine cache-busting move and shouldn't fail this test.
            inv.assert_called_once_with(
                f"{cu.K_SCOUTING_PAYLOAD_PREFIX}:7:2025-W18"
            )
            bump.assert_not_called()

    def test_falls_back_to_global_bump_when_week_unknown(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        doc = SimpleNamespace(doctype="Scouting Entry", date_of_capture=None)
        with patch.object(cu, "invalidate") as inv, \
             patch.object(cu, "invalidate_scouting_payload") as bump:
            cu.invalidate_scouting_week_for_doc(doc)
            bump.assert_called_once_with()
            inv.assert_not_called()


class TestInvalidateDispatch(unittest.TestCase):
    """invalidate_on_change should scope scouting writes to one week but keep
    the global bump for master-data changes."""

    def test_scouting_entry_busts_only_its_week(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        doc = SimpleNamespace(doctype="Scouting Entry", date_of_capture="2025-05-01")
        with patch.object(cu, "invalidate_scouting_week_for_doc") as week, \
             patch.object(cu, "invalidate_scouting_payload") as bump, \
             patch.object(cu, "invalidate"):
            cu.invalidate_on_change(doc)
            week.assert_called_once_with(doc)
            bump.assert_not_called()

    def test_master_data_keeps_global_bump(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        doc = SimpleNamespace(doctype="Zone", name="Z-1")
        with patch.object(cu, "invalidate_scouting_week_for_doc") as week, \
             patch.object(cu, "invalidate_scouting_payload") as bump, \
             patch.object(cu, "invalidate"):
            cu.invalidate_on_change(doc)
            bump.assert_called_once_with()
            week.assert_not_called()


class TestCropCatalogInvalidation(unittest.TestCase):
    def test_every_source_of_the_index_busts_it(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        for dt in ("Crop Scouted", "Pest Filter", "Disease Filter", "Warehouse", "Farm"):
            self.assertIn(cu.K_CROP_CATALOG, cu._DOC_INVALIDATIONS[dt], dt)


class TestCropCatalogSourceBumps(unittest.TestCase):
    def test_a_pest_filter_save_bumps_dashboard_aggregates_and_the_scouting_payload(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        from upande_scp.serverscripts.dashboard_aggregates import _common
        for dt in ("Pest Filter", "Disease Filter", "Crop Scouted"):
            doc = SimpleNamespace(doctype=dt, name="X")
            with patch.object(cu, "invalidate") as inv, \
                 patch.object(cu, "invalidate_scouting_payload") as payload, \
                 patch.object(_common, "bump_dash_agg_version") as agg:
                cu.invalidate_on_change(doc)
                agg.assert_called_once_with()
                payload.assert_called_once_with()
                self.assertIn(cu.K_CROP_CATALOG, [a for c in inv.call_args_list for a in c.args])


class TestCropSliceInvalidation(unittest.TestCase):
    def test_a_rose_write_busts_the_rose_slice_too(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        doc = SimpleNamespace(doctype="Scouting Entry", date_of_capture="2025-05-01",
                              crop_scouted="Rose", greenhouse="GH")
        with patch.object(cu, "scouting_payload_version", return_value=7), \
             patch.object(cu, "invalidate") as inv:
            cu.invalidate_scouting_week_for_doc(doc)
        self.assertEqual(
            [c.args[0] for c in inv.call_args_list],
            [f"{cu.K_SCOUTING_PAYLOAD_PREFIX}:7:2025-W18",
             f"{cu.K_SCOUTING_PAYLOAD_PREFIX}:7:Rose:2025-W18"],
        )

    def test_a_crop_less_write_busts_its_greenhouse_crop(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        from upande_scp.serverscripts.common import crop_catalog
        doc = SimpleNamespace(doctype="Scouting Entry", date_of_capture="2025-05-01",
                              crop_scouted=None, greenhouse="Chepsito GH 01 - KR")
        with patch.object(cu, "scouting_payload_version", return_value=7), \
             patch.object(crop_catalog, "crop_for_greenhouse", return_value="Rose"), \
             patch.object(cu, "invalidate") as inv:
            cu.invalidate_scouting_week_for_doc(doc)
        self.assertIn(f"{cu.K_SCOUTING_PAYLOAD_PREFIX}:7:Rose:2025-W18",
                      [c.args[0] for c in inv.call_args_list])

    def test_a_crop_less_block_write_busts_its_blocks_crop(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        from upande_scp.serverscripts.common import crop_catalog
        doc = SimpleNamespace(doctype="Scouting Entry", date_of_capture="2025-05-01",
                              crop_scouted=None, greenhouse=None, block="Block 1 - L")
        with patch.object(cu, "scouting_payload_version", return_value=7), \
             patch.object(crop_catalog, "crop_for_greenhouse", return_value="Avocado"), \
             patch.object(cu, "invalidate") as inv:
            cu.invalidate_scouting_week_for_doc(doc)
        self.assertIn(f"{cu.K_SCOUTING_PAYLOAD_PREFIX}:7:Avocado:2025-W18",
                      [c.args[0] for c in inv.call_args_list])


if __name__ == "__main__":
    unittest.main()
